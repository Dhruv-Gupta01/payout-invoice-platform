import { randomUUID } from "crypto";
import { GenerationStatus } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { JobQueue } from "../queue/JobQueue";
import { DriveProvider } from "../providers/DriveProvider";
import { DocsProvider } from "../providers/DocsProvider";
import { EmailProvider } from "../providers/EmailProvider";
import { notify } from "../notifications/notifier";
import { checkHardFlag, checkSoftFlag } from "./duplicateDetection";
import { checkOnboardingIncomplete, checkDocumentsNotVerified } from "./resourceReadiness";
import { buildPlaceholderRequests } from "../worker/placeholderRequests";
import { TEMPLATE_ID, TARGET_FOLDER_ID, buildDriveUrl } from "../worker/driveConfig";

// LLD §2.3
// POST /admin/invoices/generate
// Request: { sheetRowIds: string[] }
// Response 200: {
//   batchId,
//   clean: [{ sheetRowId, invoiceId }],
//   flagged: [{ sheetRowId, invoiceId, flagReason }]
// }
export interface GenerateResult {
  batchId: string;
  clean: { sheetRowId: string; invoiceId: string }[];
  flagged: { sheetRowId: string; invoiceId: string; flagReason: string }[];
}

// LLD §2.3
// GET /admin/invoices/status/:batchId
// Response 200: { batchId, total, counts: { queued, processing, generated, failed, flagged } }
export async function getBatchStatus(batchId: string) {
  const invoices = await prisma.invoice.findMany({ where: { batchId }, select: { generationStatus: true } });

  const counts = { queued: 0, processing: 0, generated: 0, failed: 0, flagged: 0 };
  const KEY_BY_STATUS: Record<GenerationStatus, keyof typeof counts> = {
    QUEUED: "queued",
    PROCESSING: "processing",
    GENERATED: "generated",
    FAILED: "failed",
    FLAGGED: "flagged",
  };
  for (const invoice of invoices) {
    counts[KEY_BY_STATUS[invoice.generationStatus]]++;
  }

  return { batchId, total: invoices.length, counts };
}

export class InvoiceNotFailedError extends Error {}

// LLD §2.3
// POST /admin/invoices/:invoiceId/retry   // only valid when generationStatus = FAILED
// Response 200: { invoiceId, generationStatus: "QUEUED" }
export async function retryInvoice(invoiceId: string, jobQueue: JobQueue) {
  const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
  if (invoice.generationStatus !== "FAILED") {
    throw new InvoiceNotFailedError();
  }

  const updated = await prisma.invoice.update({
    where: { id: invoiceId },
    data: { generationStatus: "QUEUED", errorMessage: null },
  });
  await jobQueue.enqueueInvoiceJob(updated.id);

  return { invoiceId: updated.id, generationStatus: updated.generationStatus };
}

export class AmountNotRejectedError extends Error {}

// LLD §0.9 / §2.3 / §0.24
// POST /admin/invoices/:invoiceId/reprocess   // only valid when amountConfirmationStatus = REJECTED
// Response 200: { invoiceId, amountConfirmationStatus: "PENDING", generationStatus: "QUEUED" }
// Re-derives `amount` from the current SheetRow (admin is expected to have
// corrected it first, e.g. via re-sync), resets both statuses, re-enqueues.
//
// Fixed per §0.24: deletes the old Drive file and clears driveFileId, rather
// than reusing it. buildPlaceholderRequests replaces literal {{TOKEN}} text —
// that only works once. By the time gate 1 can be rejected, the document has
// already been fully filled once, so its tokens are gone; reusing the same
// file would silently keep the old (wrong) amount in the document. Clearing
// driveFileId lets the worker's existing `if (!driveFileId)` guard (LLD §6)
// copy a fresh template on its next run — guaranteed-clean tokens.
export async function reprocessInvoice(invoiceId: string, jobQueue: JobQueue, driveProvider: DriveProvider) {
  const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
  if (invoice.amountConfirmationStatus !== "REJECTED") {
    throw new AmountNotRejectedError();
  }

  if (invoice.driveFileId) {
    await driveProvider.deleteFile(invoice.driveFileId);
  }

  const sheetRow = await prisma.sheetRow.findUniqueOrThrow({ where: { id: invoice.sheetRowId } });
  const amount = sheetRow.sheetAmount ?? sheetRow.computedAmount;

  const updated = await prisma.invoice.update({
    where: { id: invoiceId },
    data: {
      amount,
      amountConfirmationStatus: "PENDING",
      amountConfirmedAt: null,
      amountRejectionReason: null,
      generationStatus: "QUEUED",
      errorMessage: null,
      driveFileId: null,
      driveDocUrl: null,
    },
  });
  await jobQueue.enqueueInvoiceJob(updated.id);

  return {
    invoiceId: updated.id,
    amountConfirmationStatus: updated.amountConfirmationStatus,
    generationStatus: updated.generationStatus,
  };
}

export class InvoiceNotGeneratedError extends Error {}

// LLD §2.3 / §0.24 (new endpoint, user-requested)
// POST /admin/invoices/:invoiceId/regenerate-document   // only valid when generationStatus = GENERATED
// Response 200: { invoiceId, driveDocUrl }
//
// For when a resource's profile (address/PAN/bank details) is completed
// *after* their invoice was already generated — the document was filled
// with blanks for those fields at generation time, and nothing re-fills it
// automatically. Same delete-old-file-and-copy-fresh approach as the
// reprocessInvoice fix above (the old file's {{TOKENS}} are already
// consumed), but runs synchronously (not queued) and deliberately does NOT
// touch amountConfirmationStatus/approvalStatus and sends no notification —
// this corrects the document's contents, it isn't a new generation event.
export async function regenerateDocument(invoiceId: string, driveProvider: DriveProvider, docsProvider: DocsProvider) {
  const invoice = await prisma.invoice.findUniqueOrThrow({
    where: { id: invoiceId },
    include: { sheetRow: true, resource: true },
  });
  if (invoice.generationStatus !== "GENERATED") {
    throw new InvoiceNotGeneratedError();
  }

  if (invoice.driveFileId) {
    await driveProvider.deleteFile(invoice.driveFileId);
  }

  const driveFileId = await driveProvider.copyTemplate(TEMPLATE_ID, TARGET_FOLDER_ID);

  const requests = buildPlaceholderRequests({
    invoice: { invoiceNo: invoice.invoiceNo, amount: Number(invoice.amount), invoiceDate: invoice.invoiceDate ?? new Date() },
    resource: invoice.resource,
    sheetRow: { projectName: invoice.sheetRow.projectName, hours: Number(invoice.sheetRow.hours), rate: Number(invoice.sheetRow.rate) },
  });
  await docsProvider.batchUpdate(driveFileId, requests);
  await driveProvider.shareWithEmail(driveFileId, invoice.resource.email);

  const driveDocUrl = buildDriveUrl(driveFileId);
  const updated = await prisma.invoice.update({
    where: { id: invoiceId },
    data: { driveFileId, driveDocUrl },
  });

  return { invoiceId: updated.id, driveDocUrl: updated.driveDocUrl };
}

export class InvoiceNotDeclinedError extends Error {}

// LLD §2.3 / §0.29 (new endpoint, user-requested) — recovery flow for a
// gate-2 decline, which previously had no path back at all (unlike gate 1's
// reprocess). Only valid when approvalStatus = DECLINED. Resets the approval
// gate only — declineReason/actionedAt cleared, approvalStatus back to
// PENDING — and leaves everything else (amountConfirmationStatus, the
// generated document) untouched. If the document itself needs correcting,
// the admin calls the existing regenerate-document endpoint (§0.24) first,
// then this one — kept as two small, composable actions rather than one
// endpoint that always does both, matching how reprocess and
// regenerate-document are already split. Notifies the resource (their turn
// to act again), unlike reprocess/regenerate-document which don't notify.
export async function reopenInvoice(invoiceId: string, emailProvider: EmailProvider) {
  const invoice = await prisma.invoice.findUniqueOrThrow({
    where: { id: invoiceId },
    include: { resource: true },
  });
  if (invoice.approvalStatus !== "DECLINED") {
    throw new InvoiceNotDeclinedError();
  }

  const updated = await prisma.invoice.update({
    where: { id: invoiceId },
    data: { approvalStatus: "PENDING", declineReason: null, actionedAt: null },
  });

  await notify(emailProvider, "INVOICE_REOPENED", invoice.resource.email, "invoice", invoiceId);

  return { invoiceId: updated.id, approvalStatus: updated.approvalStatus };
}

async function nextInvoiceNo(): Promise<string> {
  // LLD §0.5: global sequential counter, computed inside the same
  // transaction that creates the Invoice row.
  const count = await prisma.invoice.count();
  return `INV-${String(count + 1).padStart(4, "0")}`;
}

// LLD §2.3
// POST /admin/invoices/:invoiceId/acknowledge-flag
// Response 200: { invoiceId, generationStatus: "QUEUED" }
// HLD §8: acknowledgment is logged (flagAcknowledgedBy, flagAcknowledgedAt).
export class ResourceNotReadyError extends Error {}

export async function acknowledgeFlag(invoiceId: string, adminId: string, jobQueue: JobQueue) {
  const invoiceBefore = await prisma.invoice.findUniqueOrThrow({
    where: { id: invoiceId },
    include: { resource: true },
  });

  // LLD §0.23: unlike duplicate/stale-amount reasons (always an admin
  // judgment call, freely overridable), onboarding/documents readiness is
  // re-checked here and refused if either still fails — no override.
  const onboardingReason = checkOnboardingIncomplete(invoiceBefore.resource);
  const documentsReason = await checkDocumentsNotVerified(invoiceBefore.resourceId);
  const stillNotReady = [onboardingReason, documentsReason].filter((r): r is string => r !== null);
  if (stillNotReady.length > 0) {
    throw new ResourceNotReadyError(stillNotReady.join("; "));
  }

  const invoice = await prisma.invoice.update({
    where: { id: invoiceId },
    data: {
      generationStatus: "QUEUED",
      flagAcknowledgedBy: adminId,
      flagAcknowledgedAt: new Date(),
    },
  });
  await jobQueue.enqueueInvoiceJob(invoice.id);
  return { invoiceId: invoice.id, generationStatus: invoice.generationStatus };
}

// Judgment-call flag reasons (§3 duplicate/stale-amount) are identified by
// the fixed prefixes generateInvoices below writes them with — deliberately
// string-matched rather than re-running checkHardFlag/checkSoftFlag here:
// those queries match "any invoice sharing this sheetRow's resourceEmail/
// project/batch", which by now includes the invoice being checked itself
// (it didn't exist yet when generateInvoices ran the original check) — a
// guaranteed self-match false positive that would make a duplicate-flagged
// invoice's hard flag look permanently true. The stored text is a reliable,
// simpler signal for "was this flag (also) a duplicate/amount judgment call".
const JUDGMENT_CALL_MARKERS = ["Duplicate:", "Same amount within"];

// New per user request (LLD): nothing previously re-checked a resource's
// FLAGGED invoices when the underlying onboarding/documents condition that
// flagged them actually cleared — verifyDocument and completeOnboarding only
// ever touched their own Document/Resource row, never Invoice. Called from
// both, after their own update, for the resource in question. Only clears
// (and queues) a FLAGGED invoice whose flagReason was *exclusively*
// onboarding/documents (§0.23 — the non-overridable half) and where both
// conditions are now actually met; a flag that's also a duplicate/
// stale-amount judgment call (§3) is left alone — that still needs an
// explicit human decision via acknowledge-flag, same as before. No
// flagAcknowledgedBy/At stamp here — this isn't a human override event, the
// blocking condition simply became false.
export async function autoClearReadyFlags(resourceId: string, jobQueue: JobQueue): Promise<void> {
  const resource = await prisma.resource.findUniqueOrThrow({ where: { id: resourceId } });
  const flaggedInvoices = await prisma.invoice.findMany({
    where: { resourceId, generationStatus: "FLAGGED" },
  });

  for (const invoice of flaggedInvoices) {
    if (!invoice.flagReason || JUDGMENT_CALL_MARKERS.some((m) => invoice.flagReason!.includes(m))) {
      continue;
    }

    const onboardingReason = checkOnboardingIncomplete(resource);
    const documentsReason = await checkDocumentsNotVerified(resourceId);
    if (onboardingReason || documentsReason) {
      continue;
    }

    await prisma.invoice.update({
      where: { id: invoice.id },
      data: { generationStatus: "QUEUED", flagReason: null },
    });
    await jobQueue.enqueueInvoiceJob(invoice.id);
  }
}

export async function generateInvoices(sheetRowIds: string[], jobQueue: JobQueue): Promise<GenerateResult> {
  const batchId = randomUUID();
  const clean: GenerateResult["clean"] = [];
  const flagged: GenerateResult["flagged"] = [];

  for (const sheetRowId of sheetRowIds) {
    const sheetRow = await prisma.sheetRow.findUniqueOrThrow({ where: { id: sheetRowId } });
    const resource = await prisma.resource.findUniqueOrThrow({ where: { email: sheetRow.resourceEmail } });
    const amount = sheetRow.sheetAmount ?? sheetRow.computedAmount;

    const hardFlagged = await checkHardFlag(sheetRowId);
    const softFlagMatch = await checkSoftFlag(sheetRowId);
    const onboardingReason = checkOnboardingIncomplete(resource);
    const documentsReason = await checkDocumentsNotVerified(resource.id);

    const reasons: string[] = [];
    if (hardFlagged) {
      reasons.push("Duplicate: same resource, project, and batch already invoiced");
    }
    if (softFlagMatch) {
      reasons.push(`Same amount within the last 90 days (${softFlagMatch.invoiceNo})`);
    }
    if (onboardingReason) {
      reasons.push(onboardingReason);
    }
    if (documentsReason) {
      reasons.push(documentsReason);
    }

    const invoiceNo = await nextInvoiceNo();
    const invoice = await prisma.invoice.create({
      data: {
        invoiceNo,
        batchId,
        sheetRowId,
        resourceId: resource.id,
        amount,
        generationStatus: reasons.length > 0 ? "FLAGGED" : "QUEUED",
        flagReason: reasons.length > 0 ? reasons.join("; ") : null,
      },
    });

    if (reasons.length > 0) {
      flagged.push({ sheetRowId, invoiceId: invoice.id, flagReason: invoice.flagReason! });
    } else {
      clean.push({ sheetRowId, invoiceId: invoice.id });
      await jobQueue.enqueueInvoiceJob(invoice.id);
    }
  }

  return { batchId, clean, flagged };
}

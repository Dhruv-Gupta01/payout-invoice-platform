import { parse } from "csv-parse/sync";
import { prisma } from "../lib/prisma";
import { EmailProvider } from "../providers/EmailProvider";
import { notify } from "../notifications/notifier";
import { parseLeadingNumber } from "../providers/google/sheetNumberParsing";

// LLD §0.26 / §2.3
export class ReconciliationFileFormatError extends Error {}
export class InvoiceNotEligibleError extends Error {}

interface ParsedRow {
  srNo: string;
  creditAccountNo: string;
  creditAccountName: string;
  ifsc: string;
  amount: number;
}

type RequiredField = "srNo" | "creditAccountNo" | "creditAccountName" | "ifsc" | "amount";

// Case/whitespace-insensitive header matching — same reasoning as
// RealSheetsProvider's column matching (LLD §0.15): don't assume a fixed
// position or exact casing for a file we don't control the export of.
const HEADER_ALIASES: Record<RequiredField, string[]> = {
  srNo: ["srno", "sno", "sr"],
  creditAccountNo: ["creditaccountno", "creditaccountnumber", "accountno"],
  creditAccountName: ["creditaccountname", "accountname"],
  ifsc: ["ifsc", "ifsccode"],
  amount: ["amount"],
};

function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// LLD §0.26: real bank export has quoted-comma amounts (e.g. "16,621.00") —
// csv-parse handles the quoting, parseLeadingNumber (§0.15) handles the
// thousands comma the same way real sheet amounts are already parsed.
export function parseReconciliationCsv(buffer: Buffer): ParsedRow[] {
  let records: Record<string, string>[];
  try {
    records = parse(buffer, { columns: true, skip_empty_lines: true, trim: true });
  } catch {
    throw new ReconciliationFileFormatError("Could not parse the uploaded file as CSV");
  }
  if (records.length === 0) {
    throw new ReconciliationFileFormatError("CSV file has no data rows");
  }

  const actualHeaders = Object.keys(records[0]!);
  const headerMap = {} as Record<RequiredField, string>;
  for (const field of Object.keys(HEADER_ALIASES) as RequiredField[]) {
    const found = actualHeaders.find((h) => HEADER_ALIASES[field].includes(normalizeHeader(h)));
    if (!found) {
      throw new ReconciliationFileFormatError(`Missing required column: ${field}`);
    }
    headerMap[field] = found;
  }

  return records.map((r) => ({
    srNo: (r[headerMap.srNo] ?? "").trim(),
    creditAccountNo: (r[headerMap.creditAccountNo] ?? "").trim(),
    creditAccountName: (r[headerMap.creditAccountName] ?? "").trim(),
    ifsc: (r[headerMap.ifsc] ?? "").trim(),
    amount: parseLeadingNumber(r[headerMap.amount]),
  }));
}

function accountsMatch(resourceAccountNo: string | null, resourceIfsc: string | null, row: ParsedRow): boolean {
  return (
    !!resourceAccountNo &&
    !!resourceIfsc &&
    resourceAccountNo.trim() === row.creditAccountNo &&
    resourceIfsc.trim().toUpperCase() === row.ifsc.toUpperCase()
  );
}

// LLD §0.26 / §2.3 — POST /admin/reconciliation
export async function runReconciliation(fileBuffer: Buffer, emailProvider: EmailProvider) {
  const rows = parseReconciliationCsv(fileBuffer);

  const eligibleInvoices = await prisma.invoice.findMany({
    where: { generationStatus: "GENERATED", approvalStatus: "APPROVED", paidAt: null },
    include: { resource: true },
  });
  const allBankedResources = await prisma.resource.findMany({
    where: { accountNo: { not: null }, ifsc: { not: null } },
  });

  const matched: { invoiceId: string; invoiceNo: string; resourceId: string; resourceName: string; amount: number; creditAccountNo: string }[] = [];
  const ambiguous: {
    resourceId: string;
    resourceName: string;
    amount: number;
    creditAccountNo: string;
    candidates: { invoiceId: string; invoiceNo: string }[];
  }[] = [];
  const unrecognizedRows: { srNo: string; creditAccountNo: string; creditAccountName: string; ifsc: string; amount: number; reason: string }[] = [];

  const claimedInvoiceIds = new Set<string>(); // matched this run
  const heldInvoiceIds = new Set<string>(); // ambiguous this run — excluded from "not paid" below

  for (const row of rows) {
    const candidates = eligibleInvoices.filter(
      (inv) =>
        !claimedInvoiceIds.has(inv.id) &&
        accountsMatch(inv.resource.accountNo, inv.resource.ifsc, row) &&
        Number(inv.amount) === row.amount
    );

    if (candidates.length === 1) {
      const inv = candidates[0]!;
      await prisma.invoice.update({ where: { id: inv.id }, data: { paidAt: new Date() } });
      claimedInvoiceIds.add(inv.id);
      matched.push({
        invoiceId: inv.id,
        invoiceNo: inv.invoiceNo,
        resourceId: inv.resourceId,
        resourceName: inv.resource.name,
        amount: Number(inv.amount),
        creditAccountNo: row.creditAccountNo,
      });
    } else if (candidates.length > 1) {
      for (const inv of candidates) heldInvoiceIds.add(inv.id);
      ambiguous.push({
        resourceId: candidates[0]!.resourceId,
        resourceName: candidates[0]!.resource.name,
        amount: row.amount,
        creditAccountNo: row.creditAccountNo,
        candidates: candidates.map((c) => ({ invoiceId: c.id, invoiceNo: c.invoiceNo })),
      });
    } else {
      const resourceFound = allBankedResources.some((r) => accountsMatch(r.accountNo, r.ifsc, row));
      unrecognizedRows.push({
        srNo: row.srNo,
        creditAccountNo: row.creditAccountNo,
        creditAccountName: row.creditAccountName,
        ifsc: row.ifsc,
        amount: row.amount,
        reason: resourceFound ? "resource found but no matching invoice amount" : "no matching resource",
      });
    }
  }

  const notPaid: { invoiceId: string; invoiceNo: string; resourceId: string; resourceName: string; amount: number }[] = [];
  const adminEmail = process.env.ADMIN_NOTIFICATION_EMAIL;

  for (const inv of eligibleInvoices) {
    if (claimedInvoiceIds.has(inv.id) || heldInvoiceIds.has(inv.id)) continue;

    notPaid.push({
      invoiceId: inv.id,
      invoiceNo: inv.invoiceNo,
      resourceId: inv.resourceId,
      resourceName: inv.resource.name,
      amount: Number(inv.amount),
    });

    if (!adminEmail) continue;
    // Dedup against NotificationLog (§0.26) — a repeat reconciliation run
    // must not re-email the same still-unpaid invoice every time.
    const alreadyNotified = await prisma.notificationLog.findFirst({
      where: { eventType: "INVOICE_NOT_PAID", relatedId: inv.id, status: "SENT" },
    });
    if (!alreadyNotified) {
      await notify(emailProvider, "INVOICE_NOT_PAID", adminEmail, "invoice", inv.id);
    }
  }

  return { matched, ambiguous, notPaid, unrecognizedRows };
}

// LLD §0.26 / §2.3 — POST /admin/invoices/:invoiceId/mark-paid
export async function markInvoicePaid(invoiceId: string) {
  const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
  if (invoice.generationStatus !== "GENERATED" || invoice.approvalStatus !== "APPROVED" || invoice.paidAt !== null) {
    throw new InvoiceNotEligibleError();
  }

  const updated = await prisma.invoice.update({ where: { id: invoiceId }, data: { paidAt: new Date() } });
  return { invoiceId: updated.id, paidAt: updated.paidAt };
}

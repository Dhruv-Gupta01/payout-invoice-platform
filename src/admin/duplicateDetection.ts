import { prisma } from "../lib/prisma";

// LLD §3 — Duplicate & Stale-Amount Detection — query logic.
// Run against the selected sheetRowIds before creating any Invoice rows.

// Hard flag — same resource + project + batch already invoiced.
// Note: intentionally month-agnostic, per the LLD SQL — matches across
// months, only resourceEmail + projectName + batch.
//
// resourceName is also part of the match (not just resourceEmail) because
// one email can be a shared/team inbox with many different people's rows
// in the same project+batch (e.g. a whole annotation batch billed through
// one ops email) — without resourceName, invoicing the first of those
// people would hard-flag every other person in the same batch as a false
// "duplicate", even though they're different people who both legitimately
// need an invoice.
export async function checkHardFlag(sheetRowId: string): Promise<boolean> {
  const sheetRow = await prisma.sheetRow.findUniqueOrThrow({ where: { id: sheetRowId } });

  const match = await prisma.invoice.findFirst({
    where: {
      generationStatus: { not: "FAILED" },
      sheetRow: {
        resourceEmail: sheetRow.resourceEmail,
        resourceName: sheetRow.resourceName,
        projectName: sheetRow.projectName,
        batch: sheetRow.batch,
      },
    },
  });

  return match !== null;
}

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

// Soft flag — same resource + same amount within the last 90 days.
// "amount" here is computed the same way invoice creation will use:
// sheetAmount overrides computedAmount if filled (LLD §1 SheetRow comment).
//
// Scoped by resourceName too, not just resourceId — a shared/team email
// (one Resource) can have many different people invoiced through it, and
// two different people coincidentally being paid the same amount isn't a
// stale/re-invoiced amount, it's just a coincidence. Scoping by name keeps
// this check meaningful for that case (same actual person, same amount
// again soon) instead of flagging across unrelated people.
export async function checkSoftFlag(
  sheetRowId: string
): Promise<{ invoiceNo: string; createdAt: Date } | null> {
  const sheetRow = await prisma.sheetRow.findUniqueOrThrow({ where: { id: sheetRowId } });
  const resource = await prisma.resource.findUniqueOrThrow({ where: { email: sheetRow.resourceEmail } });
  const amount = sheetRow.sheetAmount ?? sheetRow.computedAmount;

  const match = await prisma.invoice.findFirst({
    where: {
      resourceId: resource.id,
      amount,
      createdAt: { gte: new Date(Date.now() - NINETY_DAYS_MS) },
      generationStatus: { not: "FAILED" },
      sheetRow: { resourceName: sheetRow.resourceName },
    },
    select: { invoiceNo: true, createdAt: true },
  });

  return match;
}

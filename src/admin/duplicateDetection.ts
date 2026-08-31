import { prisma } from "../lib/prisma";

// LLD §3 — Duplicate & Stale-Amount Detection — query logic.
// Run against the selected sheetRowIds before creating any Invoice rows.

// Hard flag — same resource + project + batch already invoiced.
// Note: intentionally month-agnostic, per the LLD SQL — matches across
// months, only resourceEmail + projectName + batch.
export async function checkHardFlag(sheetRowId: string): Promise<boolean> {
  const sheetRow = await prisma.sheetRow.findUniqueOrThrow({ where: { id: sheetRowId } });

  const match = await prisma.invoice.findFirst({
    where: {
      generationStatus: { not: "FAILED" },
      sheetRow: {
        resourceEmail: sheetRow.resourceEmail,
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
    },
    select: { invoiceNo: true, createdAt: true },
  });

  return match;
}

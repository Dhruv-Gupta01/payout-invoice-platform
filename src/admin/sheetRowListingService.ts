import { prisma } from "../lib/prisma";

// LLD §2.3 / §0.20
// GET /admin/sheet-rows
// Response 200: [{
//   id, resourceName, resourceEmail, projectName, batch, role,
//   hours, rate, computedAmount, payableAmount,
//   invoiceId: string | null, generationStatus: string | null
// }]
// Excludes removedFromSheet rows. Ordered by lastSyncedAt then createdAt.
//
// payableAmount (not spec, user-requested) = sheetAmount ?? computedAmount —
// the actual amount an invoice would use (LLD §1: "sheetAmount ... used as
// an override if filled"), same logic invoice generation and the duplicate
// soft-flag already apply. Some real rows are paid per-item rather than
// per-hour, so their Hour column (and therefore computedAmount = hours ×
// rate) is legitimately 0 while the sheet's own Amount column carries the
// real figure — computedAmount alone made those rows look like ₹0 on the
// dashboard even though they'd invoice correctly.
export async function listSheetRows() {
  const rows = await prisma.sheetRow.findMany({
    where: { removedFromSheet: false },
    include: { invoice: { select: { id: true, generationStatus: true } } },
    orderBy: [{ lastSyncedAt: "asc" }, { createdAt: "asc" }],
  });

  return rows.map((row) => ({
    id: row.id,
    resourceName: row.resourceName,
    resourceEmail: row.resourceEmail,
    projectName: row.projectName,
    batch: row.batch,
    role: row.role,
    hours: Number(row.hours),
    rate: Number(row.rate),
    computedAmount: Number(row.computedAmount),
    payableAmount: Number(row.sheetAmount ?? row.computedAmount),
    invoiceId: row.invoice?.id ?? null,
    generationStatus: row.invoice?.generationStatus ?? null,
  }));
}

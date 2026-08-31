import { prisma } from "../lib/prisma";

// LLD §2.3 / §0.20
// GET /admin/sheet-rows
// Response 200: [{
//   id, resourceName, resourceEmail, projectName, batch, role,
//   hours, rate, computedAmount,
//   invoiceId: string | null, generationStatus: string | null
// }]
// Excludes removedFromSheet rows. Ordered by lastSyncedAt then createdAt.
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
    invoiceId: row.invoice?.id ?? null,
    generationStatus: row.invoice?.generationStatus ?? null,
  }));
}

import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { SheetsProvider } from "../providers/SheetsProvider";

// LLD §2.2
// POST /admin/sync
// Response 200: {
//   syncedAt, rowsProcessed, newResourcesCreated, rowsUpdated, rowsUnchanged, skipped
// }
export interface SyncResult {
  syncedAt: string;
  rowsProcessed: number;
  newResourcesCreated: number;
  rowsUpdated: number;
  rowsUnchanged: number;
  skipped: { rowRef: string; reason: string }[];
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function runSync(sheetsProvider: SheetsProvider): Promise<SyncResult> {
  const rows = await sheetsProvider.fetchRows();
  const syncedAt = new Date();
  let newResourcesCreated = 0;
  let rowsUpdated = 0;
  let rowsUnchanged = 0;
  const skipped: { rowRef: string; reason: string }[] = [];
  const touchedSheetRowIds: string[] = [];

  for (const row of rows) {
    // LLD §2.2: "Email is lowercased + trimmed before matching... Rows with
    // missing or malformed email are skipped and reported, not silently
    // dropped and not failing the whole sync."
    const email = row.resourceEmail.trim().toLowerCase();
    if (!EMAIL_PATTERN.test(email)) {
      skipped.push({ rowRef: `Row ${row.rowIndex}`, reason: "missing or invalid email" });
      continue;
    }

    const existingResource = await prisma.resource.findUnique({ where: { email } });
    if (!existingResource) {
      await prisma.resource.create({ data: { email, name: row.resourceName } });
      newResourcesCreated++;
    } else if (existingResource.name !== row.resourceName) {
      // LLD §0.4: sheet stays authoritative for the resource's name on every sync.
      await prisma.resource.update({ where: { email }, data: { name: row.resourceName } });
    }

    // LLD §0.1: upsert by natural key — never delete-and-reinsert, so an
    // existing Invoice's sheetRowId FK is never orphaned.
    const naturalKey = {
      resourceEmail: email,
      projectName: row.projectName,
      batch: row.batch,
      month: row.month,
    };
    const existingSheetRow = await prisma.sheetRow.findUnique({
      where: { sheet_row_natural_key: naturalKey },
    });

    if (!existingSheetRow) {
      const created = await prisma.sheetRow.create({
        data: {
          ...naturalKey,
          resourceName: row.resourceName,
          role: row.role,
          hours: row.hours,
          rate: row.rate,
          computedAmount: row.computedAmount,
          sheetAmount: row.sheetAmount ?? null,
          rawData: row.rawData as Prisma.InputJsonValue,
          removedFromSheet: false,
          lastSyncedAt: syncedAt,
        },
      });
      touchedSheetRowIds.push(created.id);
    } else {
      touchedSheetRowIds.push(existingSheetRow.id);

      const changed =
        existingSheetRow.resourceName !== row.resourceName ||
        existingSheetRow.role !== row.role ||
        Number(existingSheetRow.hours) !== row.hours ||
        Number(existingSheetRow.rate) !== row.rate ||
        Number(existingSheetRow.computedAmount) !== row.computedAmount ||
        (existingSheetRow.sheetAmount === null ? undefined : Number(existingSheetRow.sheetAmount)) !== row.sheetAmount ||
        existingSheetRow.removedFromSheet; // reappearing after being marked removed counts as a change

      await prisma.sheetRow.update({
        where: { sheet_row_natural_key: naturalKey },
        data: {
          resourceName: row.resourceName,
          role: row.role,
          hours: row.hours,
          rate: row.rate,
          computedAmount: row.computedAmount,
          sheetAmount: row.sheetAmount ?? null,
          rawData: row.rawData as Prisma.InputJsonValue,
          removedFromSheet: false,
          lastSyncedAt: syncedAt,
        },
      });

      if (changed) {
        rowsUpdated++;
      } else {
        rowsUnchanged++;
      }
    }
  }

  // LLD §2.2: a row present in a previous sync but absent from this one is
  // marked removedFromSheet = true, not deleted.
  await prisma.sheetRow.updateMany({
    where: { id: { notIn: touchedSheetRowIds }, removedFromSheet: false },
    data: { removedFromSheet: true },
  });

  return {
    syncedAt: syncedAt.toISOString(),
    rowsProcessed: rows.length,
    newResourcesCreated,
    rowsUpdated,
    rowsUnchanged,
    skipped,
  };
}

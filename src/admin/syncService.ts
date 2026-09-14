import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { SheetsProvider, RawSheetRow } from "../providers/SheetsProvider";

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

interface NaturalKey {
  resourceEmail: string;
  projectName: string;
  batch: string;
  month: string;
  resourceName: string;
  role: string;
  duplicateIndex: number;
}

//  separator — a real sheet's text fields won't contain it, so this
// can't produce a false collision the way plain concatenation could.
function keyOf(k: NaturalKey): string {
  return [k.resourceEmail, k.projectName, k.batch, k.month, k.resourceName, k.role, k.duplicateIndex].join("");
}

// Performance rewrite (user-requested) of what was previously a fully
// sequential, one-row-at-a-time loop — for 413 real sheet rows that took
// ~94s (up to 3 awaited DB round-trips per row, none batched or run
// concurrently; latency to the DB dominates, not the Sheets read itself).
// This version fetches everything it needs to know up front in a handful
// of bulk queries, resolves every row's fate in memory, then writes in
// batches (createMany / a single transaction) — a small constant number of
// round-trips regardless of row count, not O(rows).
//
// Deliberately preserves the exact previous observable behavior (same
// SyncResult counters, same DB end state) — see inline notes at each step
// for why each batched step is equivalent to what the old per-row loop did.
export async function runSync(sheetsProvider: SheetsProvider): Promise<SyncResult> {
  const rows = await sheetsProvider.fetchRows();
  const syncedAt = new Date();
  const skipped: { rowRef: string; reason: string }[] = [];

  // --- Pass 1 (pure, no DB): validate emails, assign duplicateIndex ---
  // LLD §2.2: "Email is lowercased + trimmed before matching... Rows with
  // missing or malformed email are skipped and reported, not silently
  // dropped and not failing the whole sync."
  const seenCounts = new Map<string, number>();
  const valid: { row: RawSheetRow; email: string; key: NaturalKey }[] = [];

  for (const row of rows) {
    const email = row.resourceEmail.trim().toLowerCase();
    if (!EMAIL_PATTERN.test(email)) {
      skipped.push({ rowRef: `Row ${row.rowIndex}`, reason: "missing or invalid email" });
      continue;
    }

    // resourceName + role are part of the key (not just resourceEmail +
    // project/batch/month) because one email can legitimately be one
    // shared/team inbox representing many different people's rows in the
    // same project/batch/month. duplicateIndex additionally distinguishes
    // two rows that are identical even on those (e.g. a "regular" row and a
    // separate "rework" row for the same person in the same batch).
    const dupSeenKey = `${email}${row.projectName}${row.batch}${row.month}${row.resourceName}${row.role}`;
    const duplicateIndex = seenCounts.get(dupSeenKey) ?? 0;
    seenCounts.set(dupSeenKey, duplicateIndex + 1);

    valid.push({
      row,
      email,
      key: {
        resourceEmail: email,
        projectName: row.projectName,
        batch: row.batch,
        month: row.month,
        resourceName: row.resourceName,
        role: row.role,
        duplicateIndex,
      },
    });
  }

  const distinctEmails = [...new Set(valid.map((v) => v.email))];

  // --- Pass 2: resolve Resources (one bulk read, up to two bulk writes) ---
  // LLD §0.4: sheet stays authoritative for the resource's name on every
  // sync. The old loop re-assigned the name on every mismatching row for a
  // given email, in row order — which converges to "whatever the *last*
  // row for that email in the sheet says", regardless of intermediate
  // rows (each step just overwrites-if-different). So computing the final
  // name directly from the last row per email up front, instead of
  // replaying every intermediate row, produces the identical end state.
  const existingResources = distinctEmails.length
    ? await prisma.resource.findMany({
        where: { email: { in: distinctEmails } },
        select: { email: true, name: true },
      })
    : [];
  const existingResourceNames = new Map(existingResources.map((r) => [r.email, r.name]));

  const finalNameByEmail = new Map<string, string>();
  for (const v of valid) {
    finalNameByEmail.set(v.email, v.row.resourceName); // last write wins, same as the old sequential loop
  }

  const resourcesToCreate: { email: string; name: string }[] = [];
  const resourceNameUpdates: { email: string; name: string }[] = [];
  for (const email of distinctEmails) {
    const finalName = finalNameByEmail.get(email)!;
    if (!existingResourceNames.has(email)) {
      resourcesToCreate.push({ email, name: finalName });
    } else if (existingResourceNames.get(email) !== finalName) {
      resourceNameUpdates.push({ email, name: finalName });
    }
  }

  if (resourcesToCreate.length > 0) {
    await prisma.resource.createMany({ data: resourcesToCreate, skipDuplicates: true });
  }
  if (resourceNameUpdates.length > 0) {
    await prisma.$transaction(
      resourceNameUpdates.map((r) => prisma.resource.update({ where: { email: r.email }, data: { name: r.name } }))
    );
  }
  const newResourcesCreated = resourcesToCreate.length;

  // --- Pass 3: resolve SheetRows (one bulk read, batched writes) ---
  const existingSheetRows = distinctEmails.length
    ? await prisma.sheetRow.findMany({
        where: { resourceEmail: { in: distinctEmails } },
        select: {
          id: true,
          resourceEmail: true,
          projectName: true,
          batch: true,
          month: true,
          resourceName: true,
          role: true,
          duplicateIndex: true,
          hours: true,
          rate: true,
          computedAmount: true,
          sheetAmount: true,
          removedFromSheet: true,
        },
      })
    : [];
  const existingByKey = new Map(existingSheetRows.map((r) => [keyOf(r), r]));

  const toCreate: Prisma.SheetRowCreateManyInput[] = [];
  const toUpdate: { id: string; data: Prisma.SheetRowUpdateInput }[] = [];
  let rowsUpdated = 0;
  let rowsUnchanged = 0;

  for (const v of valid) {
    const existing = existingByKey.get(keyOf(v.key));
    const writeData = {
      hours: v.row.hours,
      rate: v.row.rate,
      computedAmount: v.row.computedAmount,
      sheetAmount: v.row.sheetAmount ?? null,
      rawData: v.row.rawData as Prisma.InputJsonValue,
      removedFromSheet: false,
      lastSyncedAt: syncedAt,
    };

    if (!existing) {
      toCreate.push({ ...v.key, ...writeData });
      continue;
    }

    // resourceName/role/duplicateIndex are part of the match key itself, so
    // they can't differ here — only the non-key fields can change.
    const changed =
      Number(existing.hours) !== v.row.hours ||
      Number(existing.rate) !== v.row.rate ||
      Number(existing.computedAmount) !== v.row.computedAmount ||
      (existing.sheetAmount === null ? undefined : Number(existing.sheetAmount)) !== v.row.sheetAmount ||
      existing.removedFromSheet; // reappearing after being marked removed counts as a change

    toUpdate.push({ id: existing.id, data: writeData });
    if (changed) {
      rowsUpdated++;
    } else {
      rowsUnchanged++;
    }
  }

  if (toCreate.length > 0) {
    await prisma.sheetRow.createMany({ data: toCreate, skipDuplicates: true });
  }
  if (toUpdate.length > 0) {
    await prisma.$transaction(toUpdate.map((u) => prisma.sheetRow.update({ where: { id: u.id }, data: u.data })));
  }

  // touchedSheetRowIds = every row this sync's data matched, whether it
  // already existed (known ids from the pass-3 read above) or was just
  // created (createMany doesn't return ids — one more bulk read gets them,
  // still a single query regardless of row count).
  const touchedSheetRowIds = new Set(toUpdate.map((u) => u.id));
  if (toCreate.length > 0) {
    const createdRows = await prisma.sheetRow.findMany({
      where: { resourceEmail: { in: distinctEmails } },
      select: {
        id: true,
        resourceEmail: true,
        projectName: true,
        batch: true,
        month: true,
        resourceName: true,
        role: true,
        duplicateIndex: true,
      },
    });
    const createdKeys = new Set(toCreate.map((c) => keyOf(c as NaturalKey)));
    for (const r of createdRows) {
      if (createdKeys.has(keyOf(r))) {
        touchedSheetRowIds.add(r.id);
      }
    }
  }

  // LLD §2.2: a row present in a previous sync but absent from this one is
  // marked removedFromSheet = true, not deleted.
  await prisma.sheetRow.updateMany({
    where: { id: { notIn: [...touchedSheetRowIds] }, removedFromSheet: false },
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

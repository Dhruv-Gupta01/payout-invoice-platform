import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { FakeSheetsProvider } from "../src/providers/fakes/FakeSheetsProvider";
import { RawSheetRow } from "../src/providers/SheetsProvider";
import { FakeJobQueue } from "../src/queue/fakes/FakeJobQueue";
import { FakeDriveProvider } from "../src/providers/fakes/FakeDriveProvider";
import { FakeDocsProvider } from "../src/providers/fakes/FakeDocsProvider";
import { FakeEmailProvider } from "../src/providers/fakes/FakeEmailProvider";

// Traces to HLD §5.1 (Sync workflow, steps 3-4) and LLD §2.2:
//   POST /admin/sync
//   Response 200: { syncedAt, rowsProcessed, newResourcesCreated, rowsUpdated, rowsUnchanged, skipped }
//   "Each row is matched to a Resource by email (creating one if it doesn't exist yet)."

const ADMIN_EMAIL = "sync-admin@example.com";
const ADMIN_PASSWORD = "sync-admin-password";

async function seedAdmin() {
  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
  return prisma.adminUser.create({
    data: { email: ADMIN_EMAIL, passwordHash, name: "Sync Test Admin" },
  });
}

async function loginAsAdmin(agent: ReturnType<typeof request.agent>) {
  await agent.post("/api/auth/login").send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
}

function makeRow(overrides: Partial<RawSheetRow> = {}): RawSheetRow {
  return {
    rowIndex: 1,
    resourceEmail: "new-resource@example.com",
    resourceName: "New Resource",
    month: "2026-08",
    projectName: "Project Alpha",
    batch: "Batch1",
    role: "Developer",
    hours: 10,
    rate: 100,
    computedAmount: 1000,
    rawData: { note: "raw row as synced" },
    ...overrides,
  };
}

async function cleanDb() {
  await prisma.invoice.deleteMany();
  await prisma.sheetRow.deleteMany();
  await prisma.resource.deleteMany();
  await prisma.adminUser.deleteMany();
}

afterAll(async () => {
  await cleanDb();
  await prisma.$disconnect();
});

describe("POST /admin/sync — new row creates SheetRow + Resource", () => {
  beforeEach(cleanDb);

  it("creates a Resource and SheetRow for a row whose email doesn't exist yet", async () => {
    await seedAdmin();
    const sheetsProvider = new FakeSheetsProvider();
    sheetsProvider.setRows([makeRow()]);
    const app = createApp({ sheetsProvider, driveProvider: new FakeDriveProvider(), docsProvider: new FakeDocsProvider(), emailProvider: new FakeEmailProvider(), jobQueue: new FakeJobQueue() });

    const agent = request.agent(app);
    await loginAsAdmin(agent);

    const res = await agent.post("/api/admin/sync").send();

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      rowsProcessed: 1,
      newResourcesCreated: 1,
      rowsUpdated: 0,
      rowsUnchanged: 0,
      skipped: [],
    });
    expect(typeof res.body.syncedAt).toBe("string");

    const resource = await prisma.resource.findUnique({ where: { email: "new-resource@example.com" } });
    expect(resource).not.toBeNull();
    expect(resource?.name).toBe("New Resource");

    const sheetRow = await prisma.sheetRow.findUnique({
      where: {
        sheet_row_natural_key: {
          resourceEmail: "new-resource@example.com",
          projectName: "Project Alpha",
          batch: "Batch1",
          month: "2026-08",
          resourceName: "New Resource",
          role: "Developer",
          duplicateIndex: 0,
        },
      },
    });
    expect(sheetRow).not.toBeNull();
    expect(sheetRow?.role).toBe("Developer");
    expect(Number(sheetRow?.hours)).toBe(10);
    expect(Number(sheetRow?.rate)).toBe(100);
    expect(Number(sheetRow?.computedAmount)).toBe(1000);
  });
});

// Traces to LLD §0.1 (refinement — this is the bug the refinement exists to
// prevent):
//   "Sync must be an upsert by natural key, not delete-and-reinsert... sync
//    matches existing rows by (resourceEmail, projectName, batch, month) and
//    updates their fields, rather than deleting and recreating."
describe("POST /admin/sync — re-syncing the same row upserts, does not duplicate or orphan", () => {
  beforeEach(cleanDb);

  it("updates the existing SheetRow in place and keeps an Invoice's FK intact", async () => {
    await seedAdmin();
    const sheetsProvider = new FakeSheetsProvider();
    const originalRow = makeRow({ hours: 10, rate: 100, computedAmount: 1000 });
    sheetsProvider.setRows([originalRow]);
    const app = createApp({ sheetsProvider, driveProvider: new FakeDriveProvider(), docsProvider: new FakeDocsProvider(), emailProvider: new FakeEmailProvider(), jobQueue: new FakeJobQueue() });

    const agent = request.agent(app);
    await loginAsAdmin(agent);

    // First sync — creates the SheetRow.
    await agent.post("/api/admin/sync").send();

    const firstSheetRow = await prisma.sheetRow.findUniqueOrThrow({
      where: {
        sheet_row_natural_key: {
          resourceEmail: "new-resource@example.com",
          projectName: "Project Alpha",
          batch: "Batch1",
          month: "2026-08",
          resourceName: "New Resource",
          role: "Developer",
          duplicateIndex: 0,
        },
      },
    });

    // Simulate an invoice already generated against this row (this is the
    // FK that a delete-and-reinsert sync would orphan).
    const invoice = await prisma.invoice.create({
      data: {
        invoiceNo: "INV-TEST-0001",
        sheetRowId: firstSheetRow.id,
        resourceId: (await prisma.resource.findUniqueOrThrow({ where: { email: "new-resource@example.com" } })).id,
        amount: 1000,
      },
    });

    // Second sync — same natural key, changed hours/rate/amount (as if the
    // admin corrected the sheet).
    sheetsProvider.setRows([makeRow({ hours: 12, rate: 100, computedAmount: 1200 })]);
    const res = await agent.post("/api/admin/sync").send();

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      rowsProcessed: 1,
      newResourcesCreated: 0,
      rowsUpdated: 1,
      rowsUnchanged: 0,
    });

    const allSheetRows = await prisma.sheetRow.findMany({
      where: { resourceEmail: "new-resource@example.com" },
    });
    expect(allSheetRows).toHaveLength(1); // no duplicate
    expect(allSheetRows[0].id).toBe(firstSheetRow.id); // same row, updated in place
    expect(Number(allSheetRows[0].hours)).toBe(12);
    expect(Number(allSheetRows[0].computedAmount)).toBe(1200);

    // The Invoice's FK still resolves — not orphaned.
    const invoiceAfter = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(invoiceAfter.sheetRowId).toBe(firstSheetRow.id);
  });
});

// Traces to LLD §2.2 (matching logic):
//   "Email is lowercased + trimmed before matching against Resource.email or
//    the SheetRow natural key."
//   "Rows with missing or malformed email are skipped and reported in
//    skipped, not silently dropped and not failing the whole sync."
describe("POST /admin/sync — email handling", () => {
  beforeEach(cleanDb);

  it("skips a row with a missing email and reports it, without failing the rest of the sync", async () => {
    await seedAdmin();
    const sheetsProvider = new FakeSheetsProvider();
    sheetsProvider.setRows([
      makeRow({ rowIndex: 1, resourceEmail: "" }),
      makeRow({ rowIndex: 2, resourceEmail: "good@example.com", projectName: "Project Beta" }),
    ]);
    const app = createApp({ sheetsProvider, driveProvider: new FakeDriveProvider(), docsProvider: new FakeDocsProvider(), emailProvider: new FakeEmailProvider(), jobQueue: new FakeJobQueue() });
    const agent = request.agent(app);
    await loginAsAdmin(agent);

    const res = await agent.post("/api/admin/sync").send();

    expect(res.status).toBe(200);
    expect(res.body.rowsProcessed).toBe(2);
    expect(res.body.newResourcesCreated).toBe(1);
    expect(res.body.skipped).toEqual([{ rowRef: "Row 1", reason: "missing or invalid email" }]);

    const goodResource = await prisma.resource.findUnique({ where: { email: "good@example.com" } });
    expect(goodResource).not.toBeNull();
  });

  it("skips a row with a malformed email and reports it", async () => {
    await seedAdmin();
    const sheetsProvider = new FakeSheetsProvider();
    sheetsProvider.setRows([makeRow({ rowIndex: 3, resourceEmail: "not-an-email" })]);
    const app = createApp({ sheetsProvider, driveProvider: new FakeDriveProvider(), docsProvider: new FakeDocsProvider(), emailProvider: new FakeEmailProvider(), jobQueue: new FakeJobQueue() });
    const agent = request.agent(app);
    await loginAsAdmin(agent);

    const res = await agent.post("/api/admin/sync").send();

    expect(res.status).toBe(200);
    expect(res.body.skipped).toEqual([{ rowRef: "Row 3", reason: "missing or invalid email" }]);
  });

  it("normalizes email (lowercase + trim) before matching", async () => {
    await seedAdmin();
    const sheetsProvider = new FakeSheetsProvider();
    sheetsProvider.setRows([makeRow({ resourceEmail: "  MixedCase@Example.com  " })]);
    const app = createApp({ sheetsProvider, driveProvider: new FakeDriveProvider(), docsProvider: new FakeDocsProvider(), emailProvider: new FakeEmailProvider(), jobQueue: new FakeJobQueue() });
    const agent = request.agent(app);
    await loginAsAdmin(agent);

    await agent.post("/api/admin/sync").send();

    const resource = await prisma.resource.findUnique({ where: { email: "mixedcase@example.com" } });
    expect(resource).not.toBeNull();
  });
});

// Traces to LLD §2.2 (matching logic):
//   "A row present in a previous sync but absent from the current one is
//    marked removedFromSheet = true, not deleted — preserves any Invoice
//    history tied to it."
describe("POST /admin/sync — rows dropped from the sheet", () => {
  beforeEach(cleanDb);

  it("marks a previously-synced row removedFromSheet = true when it's absent from a later sync, without deleting it", async () => {
    await seedAdmin();
    const sheetsProvider = new FakeSheetsProvider();
    const rowA = makeRow({ rowIndex: 1, projectName: "Project A" });
    const rowB = makeRow({ rowIndex: 2, projectName: "Project B" });
    sheetsProvider.setRows([rowA, rowB]);
    const app = createApp({ sheetsProvider, driveProvider: new FakeDriveProvider(), docsProvider: new FakeDocsProvider(), emailProvider: new FakeEmailProvider(), jobQueue: new FakeJobQueue() });
    const agent = request.agent(app);
    await loginAsAdmin(agent);

    await agent.post("/api/admin/sync").send();

    const sheetRowBBefore = await prisma.sheetRow.findUniqueOrThrow({
      where: {
        sheet_row_natural_key: {
          resourceEmail: "new-resource@example.com",
          projectName: "Project B",
          batch: "Batch1",
          month: "2026-08",
          resourceName: "New Resource",
          role: "Developer",
          duplicateIndex: 0,
        },
      },
    });
    expect(sheetRowBBefore.removedFromSheet).toBe(false);

    // Second sync — only row A present now.
    sheetsProvider.setRows([rowA]);
    await agent.post("/api/admin/sync").send();

    const sheetRowBAfter = await prisma.sheetRow.findUnique({ where: { id: sheetRowBBefore.id } });
    expect(sheetRowBAfter).not.toBeNull(); // not deleted
    expect(sheetRowBAfter?.removedFromSheet).toBe(true);

    const sheetRowAAfter = await prisma.sheetRow.findUniqueOrThrow({
      where: {
        sheet_row_natural_key: {
          resourceEmail: "new-resource@example.com",
          projectName: "Project A",
          batch: "Batch1",
          month: "2026-08",
          resourceName: "New Resource",
          role: "Developer",
          duplicateIndex: 0,
        },
      },
    });
    expect(sheetRowAAfter.removedFromSheet).toBe(false);
  });
});

// Traces to the shared/team-email data-loss fix: two sheet rows that match
// on every field the natural key otherwise covers (same person, same
// project/batch/month/role — e.g. a "regular" row and a separate "rework"
// row) must still both be preserved as distinct SheetRows, not have the
// second overwrite the first.
describe("POST /admin/sync — two rows identical except in content both survive", () => {
  beforeEach(cleanDb);

  it("creates a separate SheetRow for each occurrence, and keeps updating them separately on re-sync", async () => {
    await seedAdmin();
    const sheetsProvider = new FakeSheetsProvider();
    const regularRow = makeRow({ rowIndex: 1, hours: 51, computedAmount: 25.5 });
    const reworkRow = makeRow({ rowIndex: 2, hours: 1, computedAmount: 0.2 });
    sheetsProvider.setRows([regularRow, reworkRow]);
    const app = createApp({ sheetsProvider, driveProvider: new FakeDriveProvider(), docsProvider: new FakeDocsProvider(), emailProvider: new FakeEmailProvider(), jobQueue: new FakeJobQueue() });
    const agent = request.agent(app);
    await loginAsAdmin(agent);

    const res = await agent.post("/api/admin/sync").send();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ rowsProcessed: 2, newResourcesCreated: 1, rowsUpdated: 0, rowsUnchanged: 0 });

    const rows = await prisma.sheetRow.findMany({
      where: { resourceEmail: "new-resource@example.com" },
      orderBy: { duplicateIndex: "asc" },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].duplicateIndex).toBe(0);
    expect(Number(rows[0].hours)).toBe(51);
    expect(rows[1].duplicateIndex).toBe(1);
    expect(Number(rows[1].hours)).toBe(1);

    // Re-sync with corrected numbers, same two rows in the same order —
    // each should update its own record in place, not collide.
    sheetsProvider.setRows([
      makeRow({ rowIndex: 1, hours: 52, computedAmount: 26 }),
      makeRow({ rowIndex: 2, hours: 2, computedAmount: 0.4 }),
    ]);
    const res2 = await agent.post("/api/admin/sync").send();
    expect(res2.status).toBe(200);
    expect(res2.body).toMatchObject({ rowsProcessed: 2, newResourcesCreated: 0, rowsUpdated: 2, rowsUnchanged: 0 });

    const rowsAfter = await prisma.sheetRow.findMany({
      where: { resourceEmail: "new-resource@example.com" },
      orderBy: { duplicateIndex: "asc" },
    });
    expect(rowsAfter).toHaveLength(2); // still no duplicate/collision
    expect(Number(rowsAfter[0].hours)).toBe(52);
    expect(Number(rowsAfter[1].hours)).toBe(2);
  });
});

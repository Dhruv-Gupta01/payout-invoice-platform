import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../src/lib/prisma";
import { checkHardFlag, checkSoftFlag, checkAccountAmountFlag } from "../src/admin/duplicateDetection";

// Traces to LLD §3 (Duplicate & Stale-Amount Detection — query logic):
//
// Hard flag — same resource + project + batch already invoiced:
//   SELECT 1 FROM "Invoice" i JOIN "SheetRow" sr ON i."sheetRowId" = sr.id
//   WHERE sr.resourceEmail = :resourceEmail AND sr.projectName = :projectName
//     AND sr.batch = :batch AND i.generationStatus != 'FAILED'
//
// Soft flag — same resource + same amount within 90 days:
//   SELECT invoiceNo, createdAt FROM "Invoice"
//   WHERE resourceId = :resourceId AND amount = :amount
//     AND createdAt >= NOW() - INTERVAL '90 days' AND generationStatus != 'FAILED'

async function cleanDb() {
  await prisma.invoice.deleteMany();
  await prisma.sheetRow.deleteMany();
  await prisma.resource.deleteMany();
}

afterAll(async () => {
  await cleanDb();
  await prisma.$disconnect();
});

async function seedResource(email = "flag-test@example.com") {
  return prisma.resource.create({ data: { email, name: "Flag Test Resource" } });
}

interface SheetRowOverrides {
  projectName?: string;
  batch?: string;
  month?: string;
  computedAmount?: number;
  resourceName?: string;
}

async function seedSheetRow(overrides: SheetRowOverrides = {}) {
  return prisma.sheetRow.create({
    data: {
      resourceEmail: "flag-test@example.com",
      resourceName: "Flag Test Resource",
      month: "2026-08",
      projectName: "Project Alpha",
      batch: "Batch1",
      role: "Developer",
      hours: 10,
      rate: 100,
      computedAmount: 1000,
      rawData: {},
      ...overrides,
    },
  });
}

describe("checkHardFlag", () => {
  beforeEach(cleanDb);

  it("returns true when the same resource+project+batch already has a non-FAILED invoice", async () => {
    await seedResource();
    const invoicedRow = await seedSheetRow({ month: "2026-07" });
    const resource = await prisma.resource.findUniqueOrThrow({ where: { email: "flag-test@example.com" } });
    await prisma.invoice.create({
      data: {
        invoiceNo: "INV-HARD-0001",
        sheetRowId: invoicedRow.id,
        resourceId: resource.id,
        amount: 1000,
        generationStatus: "GENERATED",
      },
    });

    // A different month, same resource+project+batch.
    const newRow = await seedSheetRow({ month: "2026-08" });

    expect(await checkHardFlag(newRow.id)).toBe(true);
  });

  it("returns false when the batch differs", async () => {
    await seedResource();
    const invoicedRow = await seedSheetRow({ batch: "Batch1" });
    const resource = await prisma.resource.findUniqueOrThrow({ where: { email: "flag-test@example.com" } });
    await prisma.invoice.create({
      data: {
        invoiceNo: "INV-HARD-0002",
        sheetRowId: invoicedRow.id,
        resourceId: resource.id,
        amount: 1000,
        generationStatus: "GENERATED",
      },
    });

    const differentBatchRow = await seedSheetRow({ batch: "Batch2" });

    expect(await checkHardFlag(differentBatchRow.id)).toBe(false);
  });

  it("returns false when the only matching invoice is FAILED", async () => {
    await seedResource();
    const invoicedRow = await seedSheetRow({ month: "2026-07" });
    const resource = await prisma.resource.findUniqueOrThrow({ where: { email: "flag-test@example.com" } });
    await prisma.invoice.create({
      data: {
        invoiceNo: "INV-HARD-0003",
        sheetRowId: invoicedRow.id,
        resourceId: resource.id,
        amount: 1000,
        generationStatus: "FAILED",
      },
    });

    const newRow = await seedSheetRow({ month: "2026-08" });

    expect(await checkHardFlag(newRow.id)).toBe(false);
  });

  // A shared/team email is one Resource representing many different real
  // people's rows — invoicing the first person in a batch must not
  // false-flag every other person in the same project+batch as a
  // "duplicate" just because they share the resource's email.
  it("returns false for a different person under the same resource+project+batch", async () => {
    await seedResource();
    const invoicedRow = await seedSheetRow({ resourceName: "Alice" });
    const resource = await prisma.resource.findUniqueOrThrow({ where: { email: "flag-test@example.com" } });
    await prisma.invoice.create({
      data: {
        invoiceNo: "INV-HARD-0004",
        sheetRowId: invoicedRow.id,
        resourceId: resource.id,
        amount: 1000,
        generationStatus: "GENERATED",
      },
    });

    const otherPersonRow = await seedSheetRow({ resourceName: "Bob" });

    expect(await checkHardFlag(otherPersonRow.id)).toBe(false);
  });
});

describe("checkSoftFlag", () => {
  beforeEach(cleanDb);

  it("returns the matching invoice when the same resource+amount exists within 90 days", async () => {
    const resource = await seedResource();
    const priorRow = await seedSheetRow({ projectName: "Project Beta", month: "2026-07" });
    await prisma.invoice.create({
      data: {
        invoiceNo: "INV-SOFT-0001",
        sheetRowId: priorRow.id,
        resourceId: resource.id,
        amount: 1000,
        generationStatus: "GENERATED",
      },
    });

    const newRow = await seedSheetRow({ projectName: "Project Gamma", month: "2026-08" }); // same amount (1000), different project

    const result = await checkSoftFlag(newRow.id);
    expect(result).not.toBeNull();
    expect(result?.invoiceNo).toBe("INV-SOFT-0001");
  });

  it("returns null when the amount differs", async () => {
    const resource = await seedResource();
    const priorRow = await seedSheetRow({ projectName: "Project Beta", computedAmount: 500 });
    await prisma.invoice.create({
      data: {
        invoiceNo: "INV-SOFT-0002",
        sheetRowId: priorRow.id,
        resourceId: resource.id,
        amount: 500,
        generationStatus: "GENERATED",
      },
    });

    const newRow = await seedSheetRow({ projectName: "Project Gamma", computedAmount: 1000 });

    expect(await checkSoftFlag(newRow.id)).toBeNull();
  });

  it("returns null when the matching invoice is older than 90 days", async () => {
    const resource = await seedResource();
    const priorRow = await seedSheetRow({ projectName: "Project Beta" });
    const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
    await prisma.invoice.create({
      data: {
        invoiceNo: "INV-SOFT-0003",
        sheetRowId: priorRow.id,
        resourceId: resource.id,
        amount: 1000,
        generationStatus: "GENERATED",
        createdAt: oldDate,
      },
    });

    const newRow = await seedSheetRow({ projectName: "Project Gamma" });

    expect(await checkSoftFlag(newRow.id)).toBeNull();
  });

  it("returns null when the only matching invoice is FAILED", async () => {
    const resource = await seedResource();
    const priorRow = await seedSheetRow({ projectName: "Project Beta" });
    await prisma.invoice.create({
      data: {
        invoiceNo: "INV-SOFT-0004",
        sheetRowId: priorRow.id,
        resourceId: resource.id,
        amount: 1000,
        generationStatus: "FAILED",
      },
    });

    const newRow = await seedSheetRow({ projectName: "Project Gamma" });

    expect(await checkSoftFlag(newRow.id)).toBeNull();
  });

  // Two different people paid through the same shared/team resource email
  // coincidentally getting the same amount isn't a stale/re-invoiced
  // amount for either of them — it's just a coincidence.
  it("returns null when the same amount belongs to a different person under the same resource", async () => {
    const resource = await seedResource();
    const priorRow = await seedSheetRow({ projectName: "Project Beta", resourceName: "Alice" });
    await prisma.invoice.create({
      data: {
        invoiceNo: "INV-SOFT-0005",
        sheetRowId: priorRow.id,
        resourceId: resource.id,
        amount: 1000,
        generationStatus: "GENERATED",
      },
    });

    const otherPersonRow = await seedSheetRow({ projectName: "Project Gamma", resourceName: "Bob" });

    expect(await checkSoftFlag(otherPersonRow.id)).toBeNull();
  });
});

describe("neither flag triggers", () => {
  beforeEach(cleanDb);

  it("a row with no prior invoices for this resource proceeds as clean", async () => {
    await seedResource();
    const row = await seedSheetRow();

    expect(await checkHardFlag(row.id)).toBe(false);
    expect(await checkSoftFlag(row.id)).toBeNull();
  });
});

// Not LLD spec, user-requested: flag at generation time if this account
// number + amount has already been paid out before (per reconciliation
// history — any invoice with paidAt set), regardless of which Resource or
// project/batch it was invoiced under.
describe("checkAccountAmountFlag", () => {
  beforeEach(cleanDb);

  it("returns null when the resource has no account number on file yet", async () => {
    await seedResource();
    const row = await seedSheetRow();

    expect(await checkAccountAmountFlag(row.id)).toBeNull();
  });

  it("returns null when no invoice has ever been paid with this account number + amount", async () => {
    await prisma.resource.create({
      data: { email: "flag-test@example.com", name: "Flag Test Resource", accountNo: "111222333444" },
    });
    const row = await seedSheetRow();

    expect(await checkAccountAmountFlag(row.id)).toBeNull();
  });

  it("returns null when the matching account+amount invoice was never paid (paidAt null)", async () => {
    const resource = await prisma.resource.create({
      data: { email: "flag-test@example.com", name: "Flag Test Resource", accountNo: "111222333444" },
    });
    const priorRow = await seedSheetRow({ projectName: "Project Beta" });
    await prisma.invoice.create({
      data: {
        invoiceNo: "INV-ACCT-0001",
        sheetRowId: priorRow.id,
        resourceId: resource.id,
        amount: 1000,
        generationStatus: "GENERATED",
        approvalStatus: "APPROVED",
        // paidAt intentionally left null -- never reconciled.
      },
    });

    const newRow = await seedSheetRow({ projectName: "Project Gamma" });
    expect(await checkAccountAmountFlag(newRow.id)).toBeNull();
  });

  it("flags when the same account number + amount was already paid, even under a different resource", async () => {
    const paidResource = await prisma.resource.create({
      data: { email: "already-paid@example.com", name: "Already Paid", accountNo: "999888777666" },
    });
    const paidRow = await prisma.sheetRow.create({
      data: {
        resourceEmail: paidResource.email,
        resourceName: paidResource.name,
        month: "2026-07",
        projectName: "Old Project",
        batch: "OldBatch",
        role: "Developer",
        hours: 10,
        rate: 100,
        computedAmount: 1000,
        rawData: {},
      },
    });
    const paidAt = new Date("2026-08-01T00:00:00.000Z");
    await prisma.invoice.create({
      data: {
        invoiceNo: "INV-ACCT-0002",
        sheetRowId: paidRow.id,
        resourceId: paidResource.id,
        amount: 1000,
        generationStatus: "GENERATED",
        approvalStatus: "APPROVED",
        paidAt,
      },
    });

    // A different resource, same account number, same amount, brand-new row.
    const newResource = await prisma.resource.create({
      data: { email: "flag-test@example.com", name: "Flag Test Resource", accountNo: "999888777666" },
    });
    const newRow = await prisma.sheetRow.create({
      data: {
        resourceEmail: newResource.email,
        resourceName: newResource.name,
        month: "2026-09",
        projectName: "New Project",
        batch: "NewBatch",
        role: "Developer",
        hours: 10,
        rate: 100,
        computedAmount: 1000,
        rawData: {},
      },
    });

    const result = await checkAccountAmountFlag(newRow.id);
    expect(result).not.toBeNull();
    expect(result?.invoiceNo).toBe("INV-ACCT-0002");
    expect(result?.paidAt.toISOString()).toBe(paidAt.toISOString());
  });

  it("returns null when the amount differs from what was previously paid", async () => {
    const resource = await prisma.resource.create({
      data: { email: "flag-test@example.com", name: "Flag Test Resource", accountNo: "111222333444" },
    });
    const paidRow = await seedSheetRow({ projectName: "Project Beta", computedAmount: 500 });
    await prisma.invoice.create({
      data: {
        invoiceNo: "INV-ACCT-0003",
        sheetRowId: paidRow.id,
        resourceId: resource.id,
        amount: 500,
        generationStatus: "GENERATED",
        approvalStatus: "APPROVED",
        paidAt: new Date(),
      },
    });

    const newRow = await seedSheetRow({ projectName: "Project Gamma", computedAmount: 1000 });
    expect(await checkAccountAmountFlag(newRow.id)).toBeNull();
  });
});

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../src/lib/prisma";
import { checkHardFlag, checkSoftFlag } from "../src/admin/duplicateDetection";

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

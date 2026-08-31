import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { FakeSheetsProvider } from "../src/providers/fakes/FakeSheetsProvider";
import { FakeDriveProvider } from "../src/providers/fakes/FakeDriveProvider";
import { FakeDocsProvider } from "../src/providers/fakes/FakeDocsProvider";
import { FakeEmailProvider } from "../src/providers/fakes/FakeEmailProvider";
import { FakeJobQueue } from "../src/queue/fakes/FakeJobQueue";

// Traces to LLD §0.9 / §2.3 / §0.24:
//   POST /admin/invoices/:invoiceId/reprocess   // only valid when amountConfirmationStatus = REJECTED
//   Response 200: { invoiceId, amountConfirmationStatus: "PENDING", generationStatus: "QUEUED" }
//   // re-derives `amount` from the current SheetRow, resets both statuses, re-enqueues.
//   // Fixed per §0.24: deletes the old Drive file and clears driveFileId (not "reuses it") —
//   // the old file's {{TOKENS}} are already consumed and can't be refilled with the
//   // corrected amount, so reusing it would silently keep the wrong value in the document.

const ADMIN_EMAIL = "reprocess-admin@example.com";
const ADMIN_PASSWORD = "reprocess-admin-password";

async function seedAdmin() {
  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
  return prisma.adminUser.create({ data: { email: ADMIN_EMAIL, passwordHash, name: "Reprocess Admin" } });
}

async function loginAsAdmin(agent: ReturnType<typeof request.agent>) {
  await agent.post("/api/auth/login").send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
}

function buildApp(jobQueue = new FakeJobQueue(), driveProvider = new FakeDriveProvider()) {
  return {
    app: createApp({
      sheetsProvider: new FakeSheetsProvider(),
      driveProvider,
      docsProvider: new FakeDocsProvider(),
      emailProvider: new FakeEmailProvider(),
      jobQueue,
    }),
    jobQueue,
    driveProvider,
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

describe("POST /admin/invoices/:invoiceId/reprocess", () => {
  beforeEach(cleanDb);

  it("re-derives amount from the SheetRow, resets both statuses, re-enqueues, and deletes+clears the old driveFileId", async () => {
    await seedAdmin();
    const resource = await prisma.resource.create({
      data: { email: "reprocess-resource@example.com", name: "Reprocess Resource" },
    });
    const sheetRow = await prisma.sheetRow.create({
      data: {
        resourceEmail: resource.email,
        resourceName: resource.name,
        month: "2026-08",
        projectName: "Project Reprocess",
        batch: "BatchReprocess",
        role: "Developer",
        hours: 10,
        rate: 100,
        computedAmount: 1000, // original (wrong) amount the invoice was generated against
        rawData: {},
      },
    });
    const invoice = await prisma.invoice.create({
      data: {
        invoiceNo: "INV-REPROCESS-0001",
        sheetRowId: sheetRow.id,
        resourceId: resource.id,
        amount: 1000, // stale — reflects the rejected amount
        generationStatus: "GENERATED",
        driveFileId: "existing-drive-file-id",
        driveDocUrl: "https://fake-drive.example.com/files/existing-drive-file-id",
        amountConfirmationStatus: "REJECTED",
        amountRejectionReason: "Hours were wrong",
      },
    });

    // Admin corrects the underlying sheet data (simulating a re-sync fixing the hours).
    await prisma.sheetRow.update({ where: { id: sheetRow.id }, data: { hours: 12, computedAmount: 1200 } });

    const { app, jobQueue, driveProvider } = buildApp();
    const agent = request.agent(app);
    await loginAsAdmin(agent);

    const res = await agent.post(`/api/admin/invoices/${invoice.id}/reprocess`).send();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      invoiceId: invoice.id,
      amountConfirmationStatus: "PENDING",
      generationStatus: "QUEUED",
    });

    const updated = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(Number(updated.amount)).toBe(1200); // re-derived from the corrected SheetRow
    expect(updated.amountConfirmationStatus).toBe("PENDING");
    expect(updated.generationStatus).toBe("QUEUED");
    // Fixed per §0.24: the old file's placeholders are already consumed and can't be
    // refilled with the corrected amount, so it's deleted and cleared — not reused —
    // letting the worker's existing `if (!driveFileId)` guard copy a fresh template.
    expect(updated.driveFileId).toBeNull();
    expect(updated.driveDocUrl).toBeNull();
    expect(driveProvider.deleteCalls).toEqual(["existing-drive-file-id"]);

    expect(jobQueue.enqueued).toEqual([invoice.id]);
  });

  it("rejects with 400 when amountConfirmationStatus is not REJECTED", async () => {
    await seedAdmin();
    const resource = await prisma.resource.create({
      data: { email: "reprocess-resource-2@example.com", name: "Reprocess Resource 2" },
    });
    const sheetRow = await prisma.sheetRow.create({
      data: {
        resourceEmail: resource.email,
        resourceName: resource.name,
        month: "2026-08",
        projectName: "Project Reprocess 2",
        batch: "BatchReprocess2",
        role: "Developer",
        hours: 10,
        rate: 100,
        computedAmount: 1000,
        rawData: {},
      },
    });
    const invoice = await prisma.invoice.create({
      data: {
        invoiceNo: "INV-REPROCESS-0002",
        sheetRowId: sheetRow.id,
        resourceId: resource.id,
        amount: 1000,
        generationStatus: "GENERATED",
        amountConfirmationStatus: "PENDING",
      },
    });

    const { app } = buildApp();
    const agent = request.agent(app);
    await loginAsAdmin(agent);

    const res = await agent.post(`/api/admin/invoices/${invoice.id}/reprocess`).send();

    expect(res.status).toBe(400);
  });
});

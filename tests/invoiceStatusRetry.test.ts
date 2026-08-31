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

// Traces to LLD §2.3:
//   GET /admin/invoices/status/:batchId
//   Response 200: { batchId, total, counts: { queued, processing, generated, failed, flagged } }
//   POST /admin/invoices/:invoiceId/retry   // only valid when generationStatus = FAILED
//   Response 200: { invoiceId, generationStatus: "QUEUED" }

const ADMIN_EMAIL = "statusretry-admin@example.com";
const ADMIN_PASSWORD = "statusretry-admin-password";

async function seedAdmin() {
  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
  return prisma.adminUser.create({ data: { email: ADMIN_EMAIL, passwordHash, name: "Status Retry Admin" } });
}

async function loginAsAdmin(agent: ReturnType<typeof request.agent>) {
  await agent.post("/api/auth/login").send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
}

function buildApp(jobQueue = new FakeJobQueue()) {
  return {
    app: createApp({
      sheetsProvider: new FakeSheetsProvider(),
      driveProvider: new FakeDriveProvider(), docsProvider: new FakeDocsProvider(),
      emailProvider: new FakeEmailProvider(),
      jobQueue,
    }),
    jobQueue,
  };
}

async function seedResource(email: string) {
  return prisma.resource.create({ data: { email, name: "Status Retry Resource" } });
}

async function makeInvoice(resourceId: string, resourceEmail: string, generationStatus: string, batchId: string, projectName: string) {
  const sheetRow = await prisma.sheetRow.create({
    data: {
      resourceEmail,
      resourceName: "Status Retry Resource",
      month: "2026-08",
      projectName,
      batch: "BatchStatusRetry",
      role: "Developer",
      hours: 10,
      rate: 100,
      computedAmount: 1000,
      rawData: {},
    },
  });
  return prisma.invoice.create({
    data: {
      invoiceNo: `INV-SR-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sheetRowId: sheetRow.id,
      resourceId,
      amount: 1000,
      generationStatus: generationStatus as never,
      batchId,
      errorMessage: generationStatus === "FAILED" ? "Simulated failure" : null,
    },
  });
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

describe("GET /admin/invoices/status/:batchId", () => {
  beforeEach(cleanDb);

  it("returns counts grouped by generationStatus for the batch", async () => {
    await seedAdmin();
    const resource = await seedResource("statusretry-resource@example.com");
    const batchId = "batch-status-test-1";
    await makeInvoice(resource.id, resource.email, "QUEUED", batchId, "P1");
    await makeInvoice(resource.id, resource.email, "GENERATED", batchId, "P2");
    await makeInvoice(resource.id, resource.email, "FAILED", batchId, "P3");
    await makeInvoice(resource.id, resource.email, "FLAGGED", batchId, "P4");
    // A different batch's invoice should not be counted.
    await makeInvoice(resource.id, resource.email, "GENERATED", "some-other-batch", "P5");

    const { app } = buildApp();
    const agent = request.agent(app);
    await loginAsAdmin(agent);

    const res = await agent.get(`/api/admin/invoices/status/${batchId}`);

    expect(res.status).toBe(200);
    expect(res.body.batchId).toBe(batchId);
    expect(res.body.total).toBe(4);
    expect(res.body.counts).toEqual({ queued: 1, processing: 0, generated: 1, failed: 1, flagged: 1 });
  });
});

describe("POST /admin/invoices/:invoiceId/retry", () => {
  beforeEach(cleanDb);

  it("transitions a FAILED invoice back to QUEUED and re-enqueues it", async () => {
    await seedAdmin();
    const resource = await seedResource("statusretry-resource-2@example.com");
    const invoice = await makeInvoice(resource.id, resource.email, "FAILED", "batch-retry-1", "P1");

    const { app, jobQueue } = buildApp();
    const agent = request.agent(app);
    await loginAsAdmin(agent);

    const res = await agent.post(`/api/admin/invoices/${invoice.id}/retry`).send();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ invoiceId: invoice.id, generationStatus: "QUEUED" });

    const updated = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(updated.generationStatus).toBe("QUEUED");
    expect(jobQueue.enqueued).toEqual([invoice.id]);
  });

  it("rejects with 400 when the invoice isn't currently FAILED", async () => {
    await seedAdmin();
    const resource = await seedResource("statusretry-resource-3@example.com");
    const invoice = await makeInvoice(resource.id, resource.email, "GENERATED", "batch-retry-2", "P1");

    const { app } = buildApp();
    const agent = request.agent(app);
    await loginAsAdmin(agent);

    const res = await agent.post(`/api/admin/invoices/${invoice.id}/retry`).send();

    expect(res.status).toBe(400);
  });
});

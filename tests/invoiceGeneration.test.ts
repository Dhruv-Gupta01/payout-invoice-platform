import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { FakeSheetsProvider } from "../src/providers/fakes/FakeSheetsProvider";
import { FakeJobQueue } from "../src/queue/fakes/FakeJobQueue";
import { FakeDriveProvider } from "../src/providers/fakes/FakeDriveProvider";
import { FakeDocsProvider } from "../src/providers/fakes/FakeDocsProvider";
import { FakeEmailProvider } from "../src/providers/fakes/FakeEmailProvider";

// Traces to LLD §2.3:
//   POST /admin/invoices/generate
//   Request: { sheetRowIds: string[] }
//   Response 200: {
//     batchId: string,
//     clean: [{ sheetRowId, invoiceId }],       // Invoice created, generationStatus = QUEUED, job enqueued
//     flagged: [{ sheetRowId, invoiceId, flagReason }]  // Invoice created, generationStatus = FLAGGED, no job yet
//   }

const ADMIN_EMAIL = "invgen-admin@example.com";
const ADMIN_PASSWORD = "invgen-admin-password";

async function seedAdmin() {
  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
  return prisma.adminUser.create({
    data: { email: ADMIN_EMAIL, passwordHash, name: "Invoice Gen Test Admin" },
  });
}

async function loginAsAdmin(agent: ReturnType<typeof request.agent>) {
  await agent.post("/api/auth/login").send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
}

// Per LLD §0.23, generateInvoices now also flags a row when its resource
// hasn't finished onboarding or has an unverified document — orthogonal to
// duplicate/stale-amount detection. Tests about *that* logic specifically
// seed a fully "ready" resource so it isn't incidentally flagged for a
// readiness reason instead of the one under test.
async function seedReadyResource(data: { email: string; name: string }) {
  const resource = await prisma.resource.create({ data: { ...data, onboardingCompleted: true } });
  for (const docType of ["AADHAAR", "PAN", "PHOTO", "BANK_PROOF", "NDA"] as const) {
    await prisma.document.create({
      data: { resourceId: resource.id, docType, fileUrl: "https://fake-drive.example.com/f.pdf", status: "VERIFIED" },
    });
  }
  return resource;
}

async function cleanDb() {
  await prisma.document.deleteMany();
  await prisma.invoice.deleteMany();
  await prisma.sheetRow.deleteMany();
  await prisma.resource.deleteMany();
  await prisma.adminUser.deleteMany();
}

afterAll(async () => {
  await cleanDb();
  await prisma.$disconnect();
});

describe("POST /admin/invoices/generate", () => {
  beforeEach(cleanDb);

  it("creates a FLAGGED invoice for a hard-flagged row and a QUEUED invoice for a clean row in the same batch, enqueuing only the clean one", async () => {
    await seedAdmin();
    const resource = await seedReadyResource({ email: "gen-resource@example.com", name: "Gen Resource" });

    // A prior, already-invoiced row for Project X / BatchA — makes any new
    // row with the same resource+project+batch hard-flag (LLD §3).
    const priorRow = await prisma.sheetRow.create({
      data: {
        resourceEmail: resource.email,
        resourceName: resource.name,
        month: "2026-07",
        projectName: "Project X",
        batch: "BatchA",
        role: "Developer",
        hours: 10,
        rate: 100,
        computedAmount: 1000,
        rawData: {},
      },
    });
    await prisma.invoice.create({
      data: {
        invoiceNo: "INV-0001",
        sheetRowId: priorRow.id,
        resourceId: resource.id,
        amount: 1000,
        generationStatus: "GENERATED",
      },
    });

    const flaggedRow = await prisma.sheetRow.create({
      data: {
        resourceEmail: resource.email,
        resourceName: resource.name,
        month: "2026-08",
        projectName: "Project X",
        batch: "BatchA", // same resource+project+batch as priorRow -> hard flag
        role: "Developer",
        hours: 10,
        rate: 100,
        computedAmount: 1000,
        rawData: {},
      },
    });

    // A different resource entirely, so neither the hard flag (resource+
    // project+batch) nor the soft flag (resource+amount) can apply here —
    // both flags are resource-scoped (LLD §3).
    const otherResource = await seedReadyResource({ email: "gen-resource-clean@example.com", name: "Gen Resource Clean" });
    const cleanRow = await prisma.sheetRow.create({
      data: {
        resourceEmail: otherResource.email,
        resourceName: otherResource.name,
        month: "2026-08",
        projectName: "Project Y",
        batch: "BatchB",
        role: "Developer",
        hours: 5,
        rate: 200,
        computedAmount: 1000, // same amount as priorRow's invoice, but a different resource, so soft flag doesn't apply
        rawData: {},
      },
    });

    const jobQueue = new FakeJobQueue();
    const app = createApp({ sheetsProvider: new FakeSheetsProvider(), driveProvider: new FakeDriveProvider(), docsProvider: new FakeDocsProvider(), emailProvider: new FakeEmailProvider(), jobQueue });
    const agent = request.agent(app);
    await loginAsAdmin(agent);

    const res = await agent
      .post("/api/admin/invoices/generate")
      .send({ sheetRowIds: [cleanRow.id, flaggedRow.id] });

    expect(res.status).toBe(200);
    expect(typeof res.body.batchId).toBe("string");

    expect(res.body.flagged).toHaveLength(1);
    expect(res.body.flagged[0].sheetRowId).toBe(flaggedRow.id);
    expect(typeof res.body.flagged[0].flagReason).toBe("string");

    expect(res.body.clean).toHaveLength(1);
    expect(res.body.clean[0].sheetRowId).toBe(cleanRow.id);

    const flaggedInvoice = await prisma.invoice.findUniqueOrThrow({ where: { sheetRowId: flaggedRow.id } });
    expect(flaggedInvoice.generationStatus).toBe("FLAGGED");
    expect(flaggedInvoice.flagReason).not.toBeNull();
    expect(flaggedInvoice.batchId).toBe(res.body.batchId);

    const cleanInvoice = await prisma.invoice.findUniqueOrThrow({ where: { sheetRowId: cleanRow.id } });
    expect(cleanInvoice.generationStatus).toBe("QUEUED");
    expect(cleanInvoice.flagReason).toBeNull();
    expect(cleanInvoice.batchId).toBe(res.body.batchId);

    // Only the clean row's job is enqueued — flagged rows wait for
    // /admin/invoices/:invoiceId/acknowledge-flag (LLD §2.3).
    expect(jobQueue.enqueued).toEqual([cleanInvoice.id]);
  });

  it("creates a QUEUED invoice and enqueues a job for a genuinely clean row", async () => {
    await seedAdmin();
    const resource = await seedReadyResource({ email: "gen-resource-2@example.com", name: "Gen Resource 2" });
    const cleanRow = await prisma.sheetRow.create({
      data: {
        resourceEmail: resource.email,
        resourceName: resource.name,
        month: "2026-08",
        projectName: "Project Z",
        batch: "BatchC",
        role: "Developer",
        hours: 10,
        rate: 100,
        computedAmount: 1000,
        rawData: {},
      },
    });

    const jobQueue = new FakeJobQueue();
    const app = createApp({ sheetsProvider: new FakeSheetsProvider(), driveProvider: new FakeDriveProvider(), docsProvider: new FakeDocsProvider(), emailProvider: new FakeEmailProvider(), jobQueue });
    const agent = request.agent(app);
    await loginAsAdmin(agent);

    const res = await agent.post("/api/admin/invoices/generate").send({ sheetRowIds: [cleanRow.id] });

    expect(res.status).toBe(200);
    expect(res.body.flagged).toHaveLength(0);
    expect(res.body.clean).toHaveLength(1);
    expect(res.body.clean[0].sheetRowId).toBe(cleanRow.id);

    const invoiceId = res.body.clean[0].invoiceId;
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(invoice.generationStatus).toBe("QUEUED");
    expect(invoice.flagReason).toBeNull();
    expect(Number(invoice.amount)).toBe(1000);
    expect(invoice.invoiceNo).toMatch(/^INV-\d{4,}$/);

    expect(jobQueue.enqueued).toEqual([invoiceId]);
  });
});

// Traces to LLD §2.3:
//   POST /admin/invoices/:invoiceId/acknowledge-flag
//   Response 200: { invoiceId, generationStatus: "QUEUED" }  // now enqueues the job
// and HLD §8: "Every acknowledgment is logged (flag_reason,
// flag_acknowledged_by, flag_acknowledged_at) for audit purposes."
describe("POST /admin/invoices/:invoiceId/acknowledge-flag", () => {
  beforeEach(cleanDb);

  it("transitions FLAGGED to QUEUED, logs the acknowledging admin, and enqueues the job", async () => {
    const admin = await seedAdmin();
    // Per LLD §0.23, acknowledge-flag now re-checks onboarding/documents
    // readiness — this test is about the duplicate-flag override specifically,
    // so the resource is seeded fully "ready" to isolate that concern.
    const resource = await seedReadyResource({ email: "ack-resource@example.com", name: "Ack Resource" });
    const sheetRow = await prisma.sheetRow.create({
      data: {
        resourceEmail: resource.email,
        resourceName: resource.name,
        month: "2026-08",
        projectName: "Project Ack",
        batch: "BatchAck",
        role: "Developer",
        hours: 10,
        rate: 100,
        computedAmount: 1000,
        rawData: {},
      },
    });
    const invoice = await prisma.invoice.create({
      data: {
        invoiceNo: "INV-ACK-0001",
        sheetRowId: sheetRow.id,
        resourceId: resource.id,
        amount: 1000,
        generationStatus: "FLAGGED",
        flagReason: "Duplicate: same resource, project, and batch already invoiced",
      },
    });

    const jobQueue = new FakeJobQueue();
    const app = createApp({ sheetsProvider: new FakeSheetsProvider(), driveProvider: new FakeDriveProvider(), docsProvider: new FakeDocsProvider(), emailProvider: new FakeEmailProvider(), jobQueue });
    const agent = request.agent(app);
    await loginAsAdmin(agent);

    const res = await agent.post(`/api/admin/invoices/${invoice.id}/acknowledge-flag`).send();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ invoiceId: invoice.id, generationStatus: "QUEUED" });

    const updated = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(updated.generationStatus).toBe("QUEUED");
    expect(updated.flagAcknowledgedBy).toBe(admin.id);
    expect(updated.flagAcknowledgedAt).not.toBeNull();

    expect(jobQueue.enqueued).toEqual([invoice.id]);
  });
});

// Traces to LLD §0.23 (new rule, user-requested): invoice generation must
// not proceed for a resource who hasn't finished onboarding or whose
// documents aren't all verified — checked and reported separately from
// duplicate/stale-amount detection, and NOT an admin judgment call:
// acknowledge-flag re-checks specifically these two conditions and refuses
// (400) if either still fails, unlike the duplicate/stale-amount reasons.
describe("Generation readiness gate (onboarding + documents)", () => {
  beforeEach(cleanDb);

  async function makeRow(resourceEmail: string, resourceName: string) {
    return prisma.sheetRow.create({
      data: {
        resourceEmail, resourceName, month: "2026-08",
        projectName: "Project Readiness", batch: "BatchReadiness", role: "Developer",
        hours: 10, rate: 100, computedAmount: 1000, rawData: {},
      },
    });
  }

  it("flags a row when the resource has not completed onboarding", async () => {
    await seedAdmin();
    const resource = await prisma.resource.create({
      data: { email: "readiness-onboarding@example.com", name: "Readiness Onboarding", onboardingCompleted: false },
    });
    const row = await makeRow(resource.email, resource.name);

    const app = createApp({ sheetsProvider: new FakeSheetsProvider(), driveProvider: new FakeDriveProvider(), docsProvider: new FakeDocsProvider(), emailProvider: new FakeEmailProvider(), jobQueue: new FakeJobQueue() });
    const agent = request.agent(app);
    await loginAsAdmin(agent);

    const res = await agent.post("/api/admin/invoices/generate").send({ sheetRowIds: [row.id] });

    expect(res.status).toBe(200);
    expect(res.body.clean).toHaveLength(0);
    expect(res.body.flagged).toHaveLength(1);
    expect(res.body.flagged[0].flagReason).toContain("Resource has not completed onboarding");
  });

  it("flags a row when not all of the resource's documents are verified, naming the missing ones", async () => {
    await seedAdmin();
    const resource = await prisma.resource.create({
      data: { email: "readiness-docs@example.com", name: "Readiness Docs", onboardingCompleted: true },
    });
    // Only 2 of 5 required types verified — PAN pending, others missing entirely.
    await prisma.document.create({
      data: { resourceId: resource.id, docType: "AADHAAR", fileUrl: "https://fake-drive.example.com/f.pdf", status: "VERIFIED" },
    });
    await prisma.document.create({
      data: { resourceId: resource.id, docType: "PAN", fileUrl: "https://fake-drive.example.com/f.pdf", status: "PENDING_REVIEW" },
    });
    const row = await makeRow(resource.email, resource.name);

    const app = createApp({ sheetsProvider: new FakeSheetsProvider(), driveProvider: new FakeDriveProvider(), docsProvider: new FakeDocsProvider(), emailProvider: new FakeEmailProvider(), jobQueue: new FakeJobQueue() });
    const agent = request.agent(app);
    await loginAsAdmin(agent);

    const res = await agent.post("/api/admin/invoices/generate").send({ sheetRowIds: [row.id] });

    expect(res.status).toBe(200);
    expect(res.body.flagged).toHaveLength(1);
    expect(res.body.flagged[0].flagReason).toContain("4 document(s) not yet verified");
    expect(res.body.flagged[0].flagReason).toContain("PAN card");
    expect(res.body.flagged[0].flagReason).toContain("Signed NDA");
  });

  it("acknowledge-flag refuses (400) when onboarding is still incomplete", async () => {
    await seedAdmin();
    const resource = await prisma.resource.create({
      data: { email: "readiness-ack-onboarding@example.com", name: "Readiness Ack", onboardingCompleted: false },
    });
    const row = await makeRow(resource.email, resource.name);
    const invoice = await prisma.invoice.create({
      data: {
        invoiceNo: "INV-READY-0001", sheetRowId: row.id, resourceId: resource.id, amount: 1000,
        generationStatus: "FLAGGED", flagReason: "Resource has not completed onboarding",
      },
    });

    const app = createApp({ sheetsProvider: new FakeSheetsProvider(), driveProvider: new FakeDriveProvider(), docsProvider: new FakeDocsProvider(), emailProvider: new FakeEmailProvider(), jobQueue: new FakeJobQueue() });
    const agent = request.agent(app);
    await loginAsAdmin(agent);

    const res = await agent.post(`/api/admin/invoices/${invoice.id}/acknowledge-flag`).send();

    expect(res.status).toBe(400);
    const stillQueued = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(stillQueued.generationStatus).toBe("FLAGGED");
  });

  it("acknowledge-flag succeeds once the resource actually becomes ready", async () => {
    await seedAdmin();
    const resource = await prisma.resource.create({
      data: { email: "readiness-ack-fixed@example.com", name: "Readiness Ack Fixed", onboardingCompleted: false },
    });
    const row = await makeRow(resource.email, resource.name);
    const invoice = await prisma.invoice.create({
      data: {
        invoiceNo: "INV-READY-0002", sheetRowId: row.id, resourceId: resource.id, amount: 1000,
        generationStatus: "FLAGGED", flagReason: "Resource has not completed onboarding",
      },
    });

    // Admin chases the resource up; they finish onboarding and all 5 docs get verified.
    await prisma.resource.update({ where: { id: resource.id }, data: { onboardingCompleted: true } });
    for (const docType of ["AADHAAR", "PAN", "PHOTO", "BANK_PROOF", "NDA"] as const) {
      await prisma.document.create({
        data: { resourceId: resource.id, docType, fileUrl: "https://fake-drive.example.com/f.pdf", status: "VERIFIED" },
      });
    }

    const jobQueue = new FakeJobQueue();
    const app = createApp({ sheetsProvider: new FakeSheetsProvider(), driveProvider: new FakeDriveProvider(), docsProvider: new FakeDocsProvider(), emailProvider: new FakeEmailProvider(), jobQueue });
    const agent = request.agent(app);
    await loginAsAdmin(agent);

    const res = await agent.post(`/api/admin/invoices/${invoice.id}/acknowledge-flag`).send();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ invoiceId: invoice.id, generationStatus: "QUEUED" });
    expect(jobQueue.enqueued).toEqual([invoice.id]);
  });
});

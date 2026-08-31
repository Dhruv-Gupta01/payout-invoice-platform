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

// Traces to LLD §2.4 (gate 2 — only actionable once gate 1 has passed, LLD §0.9):
//   POST /resource/invoices/:invoiceId/approve
//   Response 200: { invoiceId, approvalStatus: "APPROVED", actionedAt }
//   Response 403: { error: "Not your invoice" }
//   Response 403: { error: "Confirm your payout amount first" }   // amountConfirmationStatus != CONFIRMED
//   POST /resource/invoices/:invoiceId/decline
//   Request: { reason?: string }
//   Response 200: { invoiceId, approvalStatus: "DECLINED", actionedAt }
//   Response 403: { error: "Not your invoice" }
//   Response 403: { error: "Confirm your payout amount first" }
// And HLD §5.6 / §7, and LLD §0.7: decline notifies ADMIN_NOTIFICATION_EMAIL.
//
// Fixtures default amountConfirmationStatus to CONFIRMED (gate 1 already
// passed) since these tests are about gate 2's own behavior, not gate 1 —
// gate 1 has its own dedicated tests in amountConfirmation.test.ts.

const RESOURCE_A_EMAIL = "approve-resource-a@example.com";
const RESOURCE_A_PASSWORD = "approve-resource-a-password";
const RESOURCE_B_EMAIL = "approve-resource-b@example.com";
const RESOURCE_B_PASSWORD = "approve-resource-b-password";

async function seedResourceA() {
  const passwordHash = await bcrypt.hash(RESOURCE_A_PASSWORD, 10);
  return prisma.resource.create({ data: { email: RESOURCE_A_EMAIL, passwordHash, name: "Resource A" } });
}

async function seedResourceB() {
  const passwordHash = await bcrypt.hash(RESOURCE_B_PASSWORD, 10);
  return prisma.resource.create({ data: { email: RESOURCE_B_EMAIL, passwordHash, name: "Resource B" } });
}

async function loginAsResourceA(agent: ReturnType<typeof request.agent>) {
  await agent.post("/api/auth/login").send({ email: RESOURCE_A_EMAIL, password: RESOURCE_A_PASSWORD });
}

function buildApp() {
  return createApp({
    sheetsProvider: new FakeSheetsProvider(),
    driveProvider: new FakeDriveProvider(), docsProvider: new FakeDocsProvider(),
    emailProvider: new FakeEmailProvider(),
    jobQueue: new FakeJobQueue(),
  });
}

async function makeInvoice(
  resourceId: string,
  resourceEmail: string,
  overrides: { amountConfirmationStatus?: string } = {}
) {
  const sheetRow = await prisma.sheetRow.create({
    data: {
      resourceEmail,
      resourceName: "Approve Resource",
      month: "2026-08",
      projectName: "Project Approve",
      batch: "BatchApprove",
      role: "Developer",
      hours: 10,
      rate: 100,
      computedAmount: 1000,
      rawData: {},
    },
  });
  return prisma.invoice.create({
    data: {
      invoiceNo: `INV-APPR-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sheetRowId: sheetRow.id,
      resourceId,
      amount: 1000,
      generationStatus: "GENERATED",
      approvalStatus: "PENDING",
      amountConfirmationStatus: (overrides.amountConfirmationStatus as never) ?? "CONFIRMED",
    },
  });
}

async function cleanDb() {
  await prisma.notificationLog.deleteMany();
  await prisma.invoice.deleteMany();
  await prisma.sheetRow.deleteMany();
  await prisma.resource.deleteMany();
}

afterAll(async () => {
  await cleanDb();
  await prisma.$disconnect();
});

describe("POST /resource/invoices/:invoiceId/approve", () => {
  beforeEach(cleanDb);

  it("sets approvalStatus = APPROVED, actionedAt for the resource's own invoice", async () => {
    const resourceA = await seedResourceA();
    const invoice = await makeInvoice(resourceA.id, resourceA.email);
    const app = buildApp();
    const agent = request.agent(app);
    await loginAsResourceA(agent);

    const res = await agent.post(`/api/resource/invoices/${invoice.id}/approve`).send();

    expect(res.status).toBe(200);
    expect(res.body.invoiceId).toBe(invoice.id);
    expect(res.body.approvalStatus).toBe("APPROVED");
    expect(typeof res.body.actionedAt).toBe("string");

    const updated = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(updated.approvalStatus).toBe("APPROVED");
    expect(updated.actionedAt).not.toBeNull();
  });

  it("rejects with 403 'Not your invoice' when the invoice belongs to a different resource", async () => {
    await seedResourceA();
    const resourceB = await seedResourceB();
    const invoice = await makeInvoice(resourceB.id, resourceB.email);
    const app = buildApp();
    const agent = request.agent(app);
    await loginAsResourceA(agent);

    const res = await agent.post(`/api/resource/invoices/${invoice.id}/approve`).send();

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Not your invoice" });
  });

  it("rejects with 403 'Confirm your payout amount first' when gate 1 hasn't passed", async () => {
    const resourceA = await seedResourceA();
    const invoice = await makeInvoice(resourceA.id, resourceA.email, { amountConfirmationStatus: "PENDING" });
    const app = buildApp();
    const agent = request.agent(app);
    await loginAsResourceA(agent);

    const res = await agent.post(`/api/resource/invoices/${invoice.id}/approve`).send();

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Confirm your payout amount first" });
  });
});

describe("POST /resource/invoices/:invoiceId/decline", () => {
  beforeEach(cleanDb);

  it("sets approvalStatus = DECLINED, actionedAt, and notifies ADMIN_NOTIFICATION_EMAIL", async () => {
    const resourceA = await seedResourceA();
    const invoice = await makeInvoice(resourceA.id, resourceA.email);
    const app = buildApp();
    const agent = request.agent(app);
    await loginAsResourceA(agent);

    const res = await agent.post(`/api/resource/invoices/${invoice.id}/decline`).send({ reason: "Wrong amount" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ invoiceId: invoice.id, approvalStatus: "DECLINED" });

    const updated = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(updated.approvalStatus).toBe("DECLINED");
    expect(updated.declineReason).toBe("Wrong amount");

    const log = await prisma.notificationLog.findFirstOrThrow({ where: { relatedId: invoice.id } });
    expect(log.eventType).toBe("INVOICE_DECLINED");
    expect(log.recipientEmail).toBe(process.env.ADMIN_NOTIFICATION_EMAIL);
    expect(log.status).toBe("SENT");
  });

  it("rejects with 403 'Not your invoice' when the invoice belongs to a different resource", async () => {
    await seedResourceA();
    const resourceB = await seedResourceB();
    const invoice = await makeInvoice(resourceB.id, resourceB.email);
    const app = buildApp();
    const agent = request.agent(app);
    await loginAsResourceA(agent);

    const res = await agent.post(`/api/resource/invoices/${invoice.id}/decline`).send();

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Not your invoice" });
  });

  it("rejects with 403 'Confirm your payout amount first' when gate 1 hasn't passed", async () => {
    const resourceA = await seedResourceA();
    const invoice = await makeInvoice(resourceA.id, resourceA.email, { amountConfirmationStatus: "PENDING" });
    const app = buildApp();
    const agent = request.agent(app);
    await loginAsResourceA(agent);

    const res = await agent.post(`/api/resource/invoices/${invoice.id}/decline`).send();

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Confirm your payout amount first" });
  });
});

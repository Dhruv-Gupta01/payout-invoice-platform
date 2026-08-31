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

// Traces to LLD §0.9 / §2.4 — gate 1:
//   POST /resource/invoices/:invoiceId/confirm-amount
//   Response 200: { invoiceId, amountConfirmationStatus: "CONFIRMED" }
//   Response 403: { error: "Not your invoice" }
//   POST /resource/invoices/:invoiceId/reject-amount
//   Request: { reason?: string }
//   Response 200: { invoiceId, amountConfirmationStatus: "REJECTED" }
//   Response 403: { error: "Not your invoice" }
//   // fires AMOUNT_REJECTED to admin

const RESOURCE_A_EMAIL = "amtconf-resource-a@example.com";
const RESOURCE_A_PASSWORD = "amtconf-resource-a-password";
const RESOURCE_B_EMAIL = "amtconf-resource-b@example.com";
const RESOURCE_B_PASSWORD = "amtconf-resource-b-password";

async function seedResourceA() {
  const passwordHash = await bcrypt.hash(RESOURCE_A_PASSWORD, 10);
  return prisma.resource.create({ data: { email: RESOURCE_A_EMAIL, passwordHash, name: "Amt Conf Resource A" } });
}

async function seedResourceB() {
  const passwordHash = await bcrypt.hash(RESOURCE_B_PASSWORD, 10);
  return prisma.resource.create({ data: { email: RESOURCE_B_EMAIL, passwordHash, name: "Amt Conf Resource B" } });
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

async function makeInvoice(resourceId: string, resourceEmail: string) {
  const sheetRow = await prisma.sheetRow.create({
    data: {
      resourceEmail,
      resourceName: "Amt Conf Resource",
      month: "2026-08",
      projectName: "Project AmtConf",
      batch: "BatchAmtConf",
      role: "Developer",
      hours: 10,
      rate: 100,
      computedAmount: 1000,
      rawData: {},
    },
  });
  return prisma.invoice.create({
    data: {
      invoiceNo: `INV-AMTCONF-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sheetRowId: sheetRow.id,
      resourceId,
      amount: 1000,
      generationStatus: "GENERATED",
      driveDocUrl: "https://fake-drive.example.com/files/generated.doc",
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

describe("POST /resource/invoices/:invoiceId/confirm-amount", () => {
  beforeEach(cleanDb);

  it("sets amountConfirmationStatus = CONFIRMED, stamps amountConfirmedAt", async () => {
    const resourceA = await seedResourceA();
    const invoice = await makeInvoice(resourceA.id, resourceA.email);
    const app = buildApp();
    const agent = request.agent(app);
    await loginAsResourceA(agent);

    const res = await agent.post(`/api/resource/invoices/${invoice.id}/confirm-amount`).send();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ invoiceId: invoice.id, amountConfirmationStatus: "CONFIRMED" });

    const updated = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(updated.amountConfirmationStatus).toBe("CONFIRMED");
    expect(updated.amountConfirmedAt).not.toBeNull();
  });

  it("rejects with 403 'Not your invoice' for a different resource's invoice", async () => {
    await seedResourceA();
    const resourceB = await seedResourceB();
    const invoice = await makeInvoice(resourceB.id, resourceB.email);
    const app = buildApp();
    const agent = request.agent(app);
    await loginAsResourceA(agent);

    const res = await agent.post(`/api/resource/invoices/${invoice.id}/confirm-amount`).send();

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Not your invoice" });
  });
});

describe("POST /resource/invoices/:invoiceId/reject-amount", () => {
  beforeEach(cleanDb);

  it("sets amountConfirmationStatus = REJECTED and notifies ADMIN_NOTIFICATION_EMAIL", async () => {
    const resourceA = await seedResourceA();
    const invoice = await makeInvoice(resourceA.id, resourceA.email);
    const app = buildApp();
    const agent = request.agent(app);
    await loginAsResourceA(agent);

    const res = await agent
      .post(`/api/resource/invoices/${invoice.id}/reject-amount`)
      .send({ reason: "Hours look wrong" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ invoiceId: invoice.id, amountConfirmationStatus: "REJECTED" });

    const updated = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(updated.amountConfirmationStatus).toBe("REJECTED");
    expect(updated.amountRejectionReason).toBe("Hours look wrong");
    expect(updated.amountConfirmedAt).not.toBeNull();

    const log = await prisma.notificationLog.findFirstOrThrow({ where: { relatedId: invoice.id } });
    expect(log.eventType).toBe("AMOUNT_REJECTED");
    expect(log.recipientEmail).toBe(process.env.ADMIN_NOTIFICATION_EMAIL);
    expect(log.status).toBe("SENT");
  });

  it("rejects with 403 'Not your invoice' for a different resource's invoice", async () => {
    await seedResourceA();
    const resourceB = await seedResourceB();
    const invoice = await makeInvoice(resourceB.id, resourceB.email);
    const app = buildApp();
    const agent = request.agent(app);
    await loginAsResourceA(agent);

    const res = await agent.post(`/api/resource/invoices/${invoice.id}/reject-amount`).send();

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Not your invoice" });
  });
});

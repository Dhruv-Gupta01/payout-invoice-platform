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

// Traces to LLD §2.3 / §0.29 (new endpoint, user-requested):
//   POST /admin/invoices/:invoiceId/reopen   // only valid when approvalStatus = DECLINED
//   Response 200: { invoiceId, approvalStatus: "PENDING" }
//   Response 400: { error: "Invoice is not in a DECLINED state" }
//
// Recovery flow for a gate-2 decline, which previously had no path back at
// all (unlike gate 1's reprocess). Resets approvalStatus only — leaves
// amountConfirmationStatus and the generated document untouched — and
// notifies the resource via the new INVOICE_REOPENED event.

const ADMIN_EMAIL = "reopen-admin@example.com";
const ADMIN_PASSWORD = "reopen-admin-password";

async function seedAdmin() {
  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
  return prisma.adminUser.create({ data: { email: ADMIN_EMAIL, passwordHash, name: "Reopen Admin" } });
}

async function loginAsAdmin(agent: ReturnType<typeof request.agent>) {
  await agent.post("/api/auth/login").send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
}

function buildApp() {
  return createApp({
    sheetsProvider: new FakeSheetsProvider(),
    driveProvider: new FakeDriveProvider(),
    docsProvider: new FakeDocsProvider(),
    emailProvider: new FakeEmailProvider(),
    jobQueue: new FakeJobQueue(),
  });
}

async function seedInvoice(overrides: { approvalStatus?: string; amountConfirmationStatus?: string } = {}) {
  const resource = await prisma.resource.create({
    data: { email: "reopen-resource@example.com", name: "Reopen Resource" },
  });
  const sheetRow = await prisma.sheetRow.create({
    data: {
      resourceEmail: resource.email,
      resourceName: resource.name,
      month: "2026-08",
      projectName: "Project Reopen",
      batch: "BatchReopen",
      role: "Developer",
      hours: 10,
      rate: 100,
      computedAmount: 1000,
      rawData: {},
    },
  });
  const invoice = await prisma.invoice.create({
    data: {
      invoiceNo: "INV-REOPEN-0001",
      sheetRowId: sheetRow.id,
      resourceId: resource.id,
      amount: 1000,
      generationStatus: "GENERATED",
      driveDocUrl: "https://fake-drive.example.com/files/reopen.doc",
      amountConfirmationStatus: (overrides.amountConfirmationStatus as never) ?? "CONFIRMED",
      approvalStatus: (overrides.approvalStatus as never) ?? "DECLINED",
      declineReason: "the invoice looks fishy",
      actionedAt: new Date("2026-08-20T00:00:00.000Z"),
    },
  });
  return { resource, invoice };
}

async function cleanDb() {
  await prisma.notificationLog.deleteMany();
  await prisma.invoice.deleteMany();
  await prisma.sheetRow.deleteMany();
  await prisma.resource.deleteMany();
  await prisma.adminUser.deleteMany();
}

afterAll(async () => {
  await cleanDb();
  await prisma.$disconnect();
});

describe("POST /admin/invoices/:invoiceId/reopen", () => {
  beforeEach(cleanDb);

  it("resets approvalStatus to PENDING, clears declineReason/actionedAt, leaves gate 1 untouched, and notifies the resource", async () => {
    await seedAdmin();
    const { resource, invoice } = await seedInvoice();
    const app = buildApp();
    const agent = request.agent(app);
    await loginAsAdmin(agent);

    const res = await agent.post(`/api/admin/invoices/${invoice.id}/reopen`).send();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ invoiceId: invoice.id, approvalStatus: "PENDING" });

    const updated = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(updated.approvalStatus).toBe("PENDING");
    expect(updated.declineReason).toBeNull();
    expect(updated.actionedAt).toBeNull();
    // Gate 1 and the document are untouched.
    expect(updated.amountConfirmationStatus).toBe("CONFIRMED");
    expect(updated.driveDocUrl).toBe("https://fake-drive.example.com/files/reopen.doc");

    const log = await prisma.notificationLog.findFirstOrThrow({ where: { relatedId: invoice.id } });
    expect(log.eventType).toBe("INVOICE_REOPENED");
    expect(log.recipientEmail).toBe(resource.email);
    expect(log.status).toBe("SENT");
  });

  it("rejects with 400 when the invoice isn't DECLINED", async () => {
    await seedAdmin();
    const { invoice } = await seedInvoice({ approvalStatus: "APPROVED" });
    const app = buildApp();
    const agent = request.agent(app);
    await loginAsAdmin(agent);

    const res = await agent.post(`/api/admin/invoices/${invoice.id}/reopen`).send();

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Invoice is not in a DECLINED state" });

    const unchanged = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(unchanged.approvalStatus).toBe("APPROVED");
  });
});

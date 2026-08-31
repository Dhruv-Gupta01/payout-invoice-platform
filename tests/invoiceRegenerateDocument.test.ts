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

// Traces to LLD §2.3 / §0.24 (new endpoint, user-requested):
//   POST /admin/invoices/:invoiceId/regenerate-document   // only valid when generationStatus = GENERATED
//   Response 200: { invoiceId, driveDocUrl }
//   Response 400: { error: "Invoice has not been generated yet" }
//
// For when a resource's profile (address/PAN/bank details) was completed
// *after* their invoice was already generated — the document was filled with
// blanks for those fields at generation time and nothing re-fills it
// automatically. Deletes the old Drive file (its {{TOKENS}} are already
// consumed, per §0.24), copies a fresh template, refills from *current*
// resource/sheetRow data, re-shares. Deliberately does NOT touch
// amountConfirmationStatus/approvalStatus and sends no notification — this
// corrects the document's contents, it isn't a new generation event.

const ADMIN_EMAIL = "regen-admin@example.com";
const ADMIN_PASSWORD = "regen-admin-password";

async function seedAdmin() {
  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
  return prisma.adminUser.create({ data: { email: ADMIN_EMAIL, passwordHash, name: "Regen Admin" } });
}

async function loginAsAdmin(agent: ReturnType<typeof request.agent>) {
  await agent.post("/api/auth/login").send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
}

function buildApp() {
  const driveProvider = new FakeDriveProvider();
  const docsProvider = new FakeDocsProvider();
  return {
    app: createApp({
      sheetsProvider: new FakeSheetsProvider(),
      driveProvider,
      docsProvider,
      emailProvider: new FakeEmailProvider(),
      jobQueue: new FakeJobQueue(),
    }),
    driveProvider,
    docsProvider,
  };
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

describe("POST /admin/invoices/:invoiceId/regenerate-document", () => {
  beforeEach(cleanDb);

  it("deletes the old file, copies a fresh one, refills from current resource data, and leaves approval state untouched", async () => {
    await seedAdmin();
    // Resource had no profile data at generation time (the exact bug reported).
    const resource = await prisma.resource.create({
      data: { email: "regen-resource@example.com", name: "Regen Resource" },
    });
    const sheetRow = await prisma.sheetRow.create({
      data: {
        resourceEmail: resource.email, resourceName: resource.name, month: "2026-08",
        projectName: "Project Regen", batch: "BatchRegen", role: "Developer",
        hours: 10, rate: 100, computedAmount: 1000, rawData: {},
      },
    });
    const invoice = await prisma.invoice.create({
      data: {
        invoiceNo: "INV-REGEN-0001", sheetRowId: sheetRow.id, resourceId: resource.id,
        amount: 1000, generationStatus: "GENERATED",
        driveFileId: "old-file-id", driveDocUrl: "https://fake-drive.example.com/files/old-file-id",
        amountConfirmationStatus: "CONFIRMED", approvalStatus: "APPROVED",
        actionedAt: new Date("2026-08-20T00:00:00.000Z"),
      },
    });

    // Resource completes onboarding *after* generation — the real-world trigger.
    await prisma.resource.update({
      where: { id: resource.id },
      data: { address: "1 MG Road", contactNo: "9999999999", pan: "ABCDE1234F", beneficiaryName: "Regen Resource", accountNo: "111222333", bankName: "HDFC", ifsc: "HDFC0001" },
    });

    const { app, driveProvider, docsProvider } = buildApp();
    const agent = request.agent(app);
    await loginAsAdmin(agent);

    const res = await agent.post(`/api/admin/invoices/${invoice.id}/regenerate-document`).send();

    expect(res.status).toBe(200);
    expect(res.body.invoiceId).toBe(invoice.id);
    expect(typeof res.body.driveDocUrl).toBe("string");
    expect(res.body.driveDocUrl).not.toContain("old-file-id");

    expect(driveProvider.deleteCalls).toEqual(["old-file-id"]);
    expect(driveProvider.copyTemplateCalls).toHaveLength(1);
    expect(driveProvider.shareCalls).toEqual([{ fileId: expect.any(String), email: resource.email }]);

    // The refill request must carry the *current* (now-filled-in) profile data.
    expect(docsProvider.calls).toHaveLength(1);
    const requestsJson = JSON.stringify(docsProvider.calls[0]!.requests);
    expect(requestsJson).toContain("1 MG Road");
    expect(requestsJson).toContain("ABCDE1234F");

    const updated = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(updated.driveFileId).not.toBe("old-file-id");
    expect(updated.driveDocUrl).not.toContain("old-file-id");
    // Not a new generation event — approval state and amount confirmation untouched.
    expect(updated.approvalStatus).toBe("APPROVED");
    expect(updated.amountConfirmationStatus).toBe("CONFIRMED");
    expect(updated.actionedAt?.toISOString()).toBe("2026-08-20T00:00:00.000Z");

    const notifCount = await prisma.notificationLog.count();
    expect(notifCount).toBe(0);
  });

  it("rejects with 400 when the invoice hasn't been generated yet", async () => {
    await seedAdmin();
    const resource = await prisma.resource.create({
      data: { email: "regen-resource-2@example.com", name: "Regen Resource 2" },
    });
    const sheetRow = await prisma.sheetRow.create({
      data: {
        resourceEmail: resource.email, resourceName: resource.name, month: "2026-08",
        projectName: "Project Regen 2", batch: "BatchRegen2", role: "Developer",
        hours: 10, rate: 100, computedAmount: 1000, rawData: {},
      },
    });
    const invoice = await prisma.invoice.create({
      data: {
        invoiceNo: "INV-REGEN-0002", sheetRowId: sheetRow.id, resourceId: resource.id,
        amount: 1000, generationStatus: "QUEUED",
      },
    });

    const { app } = buildApp();
    const agent = request.agent(app);
    await loginAsAdmin(agent);

    const res = await agent.post(`/api/admin/invoices/${invoice.id}/regenerate-document`).send();

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Invoice has not been generated yet" });
  });
});

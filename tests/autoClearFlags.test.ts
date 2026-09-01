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

// Traces to LLD §0.28: verifyDocument (§2.7) and completeOnboarding (§2.6)
// now both re-check the resource's FLAGGED invoices afterward and
// auto-queue any that are now ready — previously nothing did this, so a
// FLAGGED invoice sat stuck until an admin manually clicked
// acknowledge-flag, even after the resource became fully ready. Narrow by
// design: only auto-clears a flag that was *exclusively* onboarding/
// documents (§0.23) — a flag that's also duplicate/stale-amount (§3, a
// judgment call) is left alone, still needs an explicit acknowledge-flag.

const ADMIN_EMAIL = "autoclear-admin@example.com";
const ADMIN_PASSWORD = "autoclear-admin-password";
const RESOURCE_EMAIL = "autoclear-resource@example.com";
const RESOURCE_PASSWORD = "autoclear-resource-password";

const REQUIRED_DOC_TYPES = ["AADHAAR", "PAN", "PHOTO", "BANK_PROOF", "NDA", "ICA"] as const;

const ONBOARDING_BODY = {
  address: "1 MG Road",
  contactNo: "9999999999",
  pan: "ABCDE1234F",
  beneficiaryName: "Autoclear Resource",
  accountNo: "111222333",
  bankName: "HDFC",
  ifsc: "HDFC0001",
};

async function seedAdmin() {
  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
  return prisma.adminUser.create({ data: { email: ADMIN_EMAIL, passwordHash, name: "Autoclear Admin" } });
}

async function loginAsAdmin(agent: ReturnType<typeof request.agent>) {
  await agent.post("/api/auth/login").send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
}

async function seedResource(overrides: { onboardingCompleted?: boolean } = {}) {
  const passwordHash = await bcrypt.hash(RESOURCE_PASSWORD, 10);
  return prisma.resource.create({
    data: {
      email: RESOURCE_EMAIL,
      passwordHash,
      name: "Autoclear Resource",
      onboardingCompleted: overrides.onboardingCompleted ?? false,
    },
  });
}

async function loginAsResource(agent: ReturnType<typeof request.agent>) {
  await agent.post("/api/auth/login").send({ email: RESOURCE_EMAIL, password: RESOURCE_PASSWORD });
}

// Seeds one Document per required type; `pendingTypes` stay PENDING_REVIEW,
// everything else is VERIFIED. Returns the created rows keyed by docType.
async function seedDocuments(resourceId: string, pendingTypes: string[]) {
  const docs: Record<string, { id: string }> = {};
  for (const type of REQUIRED_DOC_TYPES) {
    const doc = await prisma.document.create({
      data: {
        resourceId,
        docType: type as never,
        fileUrl: `https://fake-drive.example.com/files/${type}.pdf`,
        status: pendingTypes.includes(type) ? "PENDING_REVIEW" : "VERIFIED",
        reviewedAt: pendingTypes.includes(type) ? null : new Date(),
      },
    });
    docs[type] = doc;
  }
  return docs;
}

async function seedFlaggedInvoice(resourceId: string, resourceEmail: string, flagReason: string) {
  const sheetRow = await prisma.sheetRow.create({
    data: {
      resourceEmail,
      resourceName: "Autoclear Resource",
      month: "2026-08",
      projectName: "Project Autoclear",
      batch: `Batch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      role: "Developer",
      hours: 10,
      rate: 100,
      computedAmount: 1000,
      rawData: {},
    },
  });
  return prisma.invoice.create({
    data: {
      invoiceNo: `INV-AC-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sheetRowId: sheetRow.id,
      resourceId,
      amount: 1000,
      generationStatus: "FLAGGED",
      flagReason,
    },
  });
}

function buildApp() {
  const jobQueue = new FakeJobQueue();
  return {
    app: createApp({
      sheetsProvider: new FakeSheetsProvider(),
      driveProvider: new FakeDriveProvider(),
      docsProvider: new FakeDocsProvider(),
      emailProvider: new FakeEmailProvider(),
      jobQueue,
    }),
    jobQueue,
  };
}

async function cleanDb() {
  await prisma.notificationLog.deleteMany();
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

describe("Auto-clearing FLAGGED invoices when the resource becomes ready", () => {
  beforeEach(cleanDb);

  it("verifying the last outstanding document auto-queues a readiness-only FLAGGED invoice", async () => {
    await seedAdmin();
    const resource = await seedResource({ onboardingCompleted: true });
    const docs = await seedDocuments(resource.id, ["NDA"]); // only NDA still pending
    const invoice = await seedFlaggedInvoice(resource.id, resource.email, "1 document(s) not yet verified (Signed NDA)");

    const { app, jobQueue } = buildApp();
    const agent = request.agent(app);
    await loginAsAdmin(agent);

    const res = await agent.post(`/api/admin/documents/${docs.NDA.id}/verify`).send();
    expect(res.status).toBe(200);

    const updated = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(updated.generationStatus).toBe("QUEUED");
    expect(updated.flagReason).toBeNull();
    expect(updated.flagAcknowledgedBy).toBeNull();
    expect(updated.flagAcknowledgedAt).toBeNull();
    expect(jobQueue.enqueued).toEqual([invoice.id]);
  });

  it("completing onboarding auto-queues a readiness-only FLAGGED invoice when documents are already all verified", async () => {
    const resource = await seedResource({ onboardingCompleted: false });
    await seedDocuments(resource.id, []); // all 5 already verified
    const invoice = await seedFlaggedInvoice(resource.id, resource.email, "Resource has not completed onboarding");

    const { app, jobQueue } = buildApp();
    const agent = request.agent(app);
    await loginAsResource(agent);

    const res = await agent.post("/api/resource/onboarding").send(ONBOARDING_BODY);
    expect(res.status).toBe(200);

    const updated = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(updated.generationStatus).toBe("QUEUED");
    expect(updated.flagReason).toBeNull();
    expect(jobQueue.enqueued).toEqual([invoice.id]);
  });

  it("does NOT auto-queue when the flag was also a duplicate/stale-amount judgment call, even once ready", async () => {
    await seedAdmin();
    const resource = await seedResource({ onboardingCompleted: true });
    const docs = await seedDocuments(resource.id, ["NDA"]);
    const invoice = await seedFlaggedInvoice(
      resource.id,
      resource.email,
      "Duplicate: same resource, project, and batch already invoiced; 1 document(s) not yet verified (Signed NDA)"
    );

    const { app, jobQueue } = buildApp();
    const agent = request.agent(app);
    await loginAsAdmin(agent);

    const res = await agent.post(`/api/admin/documents/${docs.NDA.id}/verify`).send();
    expect(res.status).toBe(200);

    const updated = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(updated.generationStatus).toBe("FLAGGED"); // still needs an explicit acknowledge-flag
    expect(updated.flagReason).not.toBeNull();
    expect(jobQueue.enqueued).toEqual([]);
  });

  it("does NOT auto-queue while another required document is still unverified", async () => {
    await seedAdmin();
    const resource = await seedResource({ onboardingCompleted: true });
    const docs = await seedDocuments(resource.id, ["NDA", "PHOTO"]); // two still pending
    const invoice = await seedFlaggedInvoice(
      resource.id,
      resource.email,
      "2 document(s) not yet verified (Passport-size photo, Signed NDA)"
    );

    const { app, jobQueue } = buildApp();
    const agent = request.agent(app);
    await loginAsAdmin(agent);

    // Verify only one of the two outstanding documents.
    const res = await agent.post(`/api/admin/documents/${docs.NDA.id}/verify`).send();
    expect(res.status).toBe(200);

    const updated = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(updated.generationStatus).toBe("FLAGGED"); // PHOTO is still PENDING_REVIEW
    expect(jobQueue.enqueued).toEqual([]);
  });
});

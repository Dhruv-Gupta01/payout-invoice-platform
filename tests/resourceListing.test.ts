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

// Traces to LLD §2.5:
//   GET /admin/resources
//   Response 200: [{ id, name, email, totalInvoices, pending, approved, declined, pendingDocuments: boolean }]
//
//   GET /admin/resources/:id
//   Response 200: {
//     id, name, email, address, contactNo, pan,
//     beneficiaryName, accountNo, bankName, ifsc,
//     bankLocked, onboardingCompleted,
//     invoices: [...],   // same shape as 2.4
//     documents: [...]   // same shape as 2.7
//   }
//
// The LLD fixes the summary shape to exactly {pending, approved, declined}
// but the actual model has more granular states than that (two gates —
// AmountConfirmationStatus and ApprovalStatus — plus pre-generation
// GenerationStatus). Not specified which states map to which bucket;
// flagging the assumption used here rather than deciding silently:
//   - approved  = approvalStatus === "APPROVED"
//   - declined  = approvalStatus === "DECLINED" OR amountConfirmationStatus
//                 === "REJECTED" (the resource said no at either gate —
//                 already treated the same way for notifications, see
//                 AMOUNT_REJECTED / INVOICE_DECLINED)
//   - pending   = totalInvoices - approved - declined (covers everything
//                 else: not yet generated, gate 1 pending, gate 2 pending)
// pendingDocuments is read the same way: true if the resource has any
// Document with status PENDING_REVIEW (awaiting admin action) — not
// "documents not yet uploaded", which isn't tracked as a state at all.

const ADMIN_EMAIL = "reslist-admin@example.com";
const ADMIN_PASSWORD = "reslist-admin-password";

async function seedAdmin() {
  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
  return prisma.adminUser.create({ data: { email: ADMIN_EMAIL, passwordHash, name: "Reslist Admin" } });
}

async function loginAsAdmin(agent: ReturnType<typeof request.agent>) {
  await agent.post("/api/auth/login").send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
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
  overrides: {
    generationStatus?: string;
    amountConfirmationStatus?: string;
    approvalStatus?: string;
  } = {}
) {
  const sheetRow = await prisma.sheetRow.create({
    data: {
      resourceEmail,
      resourceName: "Reslist Resource",
      month: "2026-08",
      projectName: "Project Reslist",
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
      invoiceNo: `INV-RESLIST-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sheetRowId: sheetRow.id,
      resourceId,
      amount: 1000,
      generationStatus: (overrides.generationStatus as never) ?? "GENERATED",
      amountConfirmationStatus: (overrides.amountConfirmationStatus as never) ?? "PENDING",
      approvalStatus: (overrides.approvalStatus as never) ?? "NOT_APPLICABLE",
      driveDocUrl: "https://fake-drive.example.com/files/reslist.doc",
    },
  });
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

describe("GET /admin/resources", () => {
  beforeEach(cleanDb);

  it("summarizes each resource's invoice counts and pending-document flag", async () => {
    await seedAdmin();
    const resourceA = await prisma.resource.create({
      data: { email: "reslist-a@example.com", name: "Resource A" },
    });
    const resourceB = await prisma.resource.create({
      data: { email: "reslist-b@example.com", name: "Resource B" },
    });

    // Resource A: one approved, one gate-2 pending, one gate-1 pending.
    await makeInvoice(resourceA.id, resourceA.email, {
      amountConfirmationStatus: "CONFIRMED",
      approvalStatus: "APPROVED",
    });
    await makeInvoice(resourceA.id, resourceA.email, {
      amountConfirmationStatus: "CONFIRMED",
      approvalStatus: "PENDING",
    });
    await makeInvoice(resourceA.id, resourceA.email, {
      amountConfirmationStatus: "PENDING",
      approvalStatus: "NOT_APPLICABLE",
    });
    await prisma.document.create({
      data: {
        resourceId: resourceA.id,
        docType: "PAN",
        fileUrl: "https://fake-drive.example.com/files/a-pan.pdf",
        status: "PENDING_REVIEW",
      },
    });

    // Resource B: one gate-2 declined, one gate-1 rejected. No documents.
    await makeInvoice(resourceB.id, resourceB.email, {
      amountConfirmationStatus: "CONFIRMED",
      approvalStatus: "DECLINED",
    });
    await makeInvoice(resourceB.id, resourceB.email, {
      amountConfirmationStatus: "REJECTED",
      approvalStatus: "NOT_APPLICABLE",
    });

    const app = buildApp();
    const agent = request.agent(app);
    await loginAsAdmin(agent);

    const res = await agent.get("/api/admin/resources");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);

    const a = res.body.find((r: { id: string }) => r.id === resourceA.id);
    expect(a).toEqual({
      id: resourceA.id,
      name: "Resource A",
      email: resourceA.email,
      totalInvoices: 3,
      pending: 2,
      approved: 1,
      declined: 0,
      pendingDocuments: true,
    });

    const b = res.body.find((r: { id: string }) => r.id === resourceB.id);
    expect(b).toEqual({
      id: resourceB.id,
      name: "Resource B",
      email: resourceB.email,
      totalInvoices: 2,
      pending: 0,
      approved: 0,
      declined: 2,
      pendingDocuments: false,
    });
  });
});

describe("GET /admin/resources/:id", () => {
  beforeEach(cleanDb);

  it("returns full profile, bank details, invoices, and documents for one resource", async () => {
    await seedAdmin();
    const resource = await prisma.resource.create({
      data: {
        email: "reslist-detail@example.com",
        name: "Detail Resource",
        address: "12, Sector 3, Bengaluru",
        contactNo: "+91 98120 34210",
        pan: "ABCPG1234K",
        beneficiaryName: "Detail Resource",
        accountNo: "50110007842910",
        bankName: "HDFC Bank",
        ifsc: "HDFC0002100",
        bankLocked: true,
        onboardingCompleted: true,
      },
    });
    const invoice = await makeInvoice(resource.id, resource.email, {
      amountConfirmationStatus: "CONFIRMED",
      approvalStatus: "APPROVED",
    });
    const doc = await prisma.document.create({
      data: {
        resourceId: resource.id,
        docType: "NDA",
        fileUrl: "https://fake-drive.example.com/files/detail-nda.pdf",
        status: "VERIFIED",
        reviewedAt: new Date("2026-08-10T00:00:00.000Z"),
      },
    });

    const app = buildApp();
    const agent = request.agent(app);
    await loginAsAdmin(agent);

    const res = await agent.get(`/api/admin/resources/${resource.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: resource.id,
      name: "Detail Resource",
      email: resource.email,
      address: resource.address,
      contactNo: resource.contactNo,
      pan: resource.pan,
      beneficiaryName: resource.beneficiaryName,
      accountNo: resource.accountNo,
      bankName: resource.bankName,
      ifsc: resource.ifsc,
      bankLocked: true,
      onboardingCompleted: true,
    });
    expect(res.body.invoices).toHaveLength(1);
    expect(res.body.invoices[0]).toMatchObject({ id: invoice.id, approvalStatus: "APPROVED" });
    expect(res.body.documents).toEqual([
      {
        id: doc.id,
        docType: "NDA",
        fileUrl: doc.fileUrl,
        status: "VERIFIED",
        rejectionReason: null,
        reviewedAt: doc.reviewedAt!.toISOString(),
        uploadedAt: doc.uploadedAt.toISOString(),
      },
    ]);
  });

  // Traces to LLD §0.25: GET /admin/resources/:id now also surfaces invite
  // status, so the admin UI can show whether a resource can log in yet.
  it("surfaces accountActivated and inviteExpiresAt", async () => {
    await seedAdmin();
    const notInvited = await prisma.resource.create({
      data: { email: "reslist-not-invited@example.com", name: "Not Invited" },
    });
    const invitedPending = await prisma.resource.create({
      data: {
        email: "reslist-invited@example.com", name: "Invited Pending",
        inviteToken: "some-token", inviteTokenExpiresAt: new Date("2026-09-05T00:00:00.000Z"),
      },
    });
    const activated = await prisma.resource.create({
      data: { email: "reslist-activated@example.com", name: "Activated", passwordHash: "some-hash" },
    });

    const app = buildApp();
    const agent = request.agent(app);
    await loginAsAdmin(agent);

    const notInvitedRes = await agent.get(`/api/admin/resources/${notInvited.id}`);
    expect(notInvitedRes.body).toMatchObject({ accountActivated: false, inviteExpiresAt: null });

    const invitedRes = await agent.get(`/api/admin/resources/${invitedPending.id}`);
    expect(invitedRes.body).toMatchObject({
      accountActivated: false,
      inviteExpiresAt: "2026-09-05T00:00:00.000Z",
    });

    const activatedRes = await agent.get(`/api/admin/resources/${activated.id}`);
    expect(activatedRes.body).toMatchObject({ accountActivated: true, inviteExpiresAt: null });
  });

  // Not LLD-specified; a real robustness bug found live in the browser
  // (Phase 9 manual check): a stale/unknown id hit `findUniqueOrThrow`
  // unguarded, which threw inside an async Express 4 handler — Express 4
  // doesn't auto-catch a rejected promise from an async route handler, so
  // the request never got a response (infinite spinner client-side) and the
  // uncaught rejection crashed the *entire* backend process, taking down
  // the API for every other request in flight too. Fixed with a global
  // error-handling middleware (src/app.ts) + an asyncHandler wrapper
  // (src/lib/asyncHandler.ts) applied to every route across all routers —
  // not just this one — since the same unguarded-findUniqueOrThrow pattern
  // existed on several other routes.
  it("returns 404 (not a crash or a hang) for an unknown resource id", async () => {
    await seedAdmin();
    const app = buildApp();
    const agent = request.agent(app);
    await loginAsAdmin(agent);

    const res = await agent.get("/api/admin/resources/00000000-0000-0000-0000-000000000000");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Not found" });
  });
});

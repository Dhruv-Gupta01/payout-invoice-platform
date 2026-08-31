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

// Traces to LLD §2.7:
//   POST /admin/documents/:id/verify
//   Response 200: { id, status: "VERIFIED", reviewedAt }
//   POST /admin/documents/:id/reject
//   Request: { reason: string }
//   Response 200: { id, status: "REJECTED", reviewedAt, rejectionReason }
// And HLD §5.4: "Verify or Reject (+ reason) → status updated, reviewer +
// timestamp logged."
// And HLD §7 (Notifications), reminder from Phase 4:
//   "Document verified | Resource | Admin marks a document verified"
//   "Document rejected | Resource | Admin marks a document rejected (includes reason)"

const ADMIN_EMAIL = "docreview-admin@example.com";
const ADMIN_PASSWORD = "docreview-admin-password";

async function seedAdmin() {
  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
  return prisma.adminUser.create({
    data: { email: ADMIN_EMAIL, passwordHash, name: "Doc Review Admin" },
  });
}

async function loginAsAdmin(agent: ReturnType<typeof request.agent>) {
  await agent.post("/api/auth/login").send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
}

async function seedResourceWithDocument() {
  const resource = await prisma.resource.create({
    data: { email: "review-resource@example.com", name: "Review Resource" },
  });
  const document = await prisma.document.create({
    data: {
      resourceId: resource.id,
      docType: "PAN",
      fileUrl: "https://fake-drive.example.com/files/pan.pdf",
      status: "PENDING_REVIEW",
    },
  });
  return { resource, document };
}

function buildApp() {
  return createApp({
    sheetsProvider: new FakeSheetsProvider(),
    driveProvider: new FakeDriveProvider(), docsProvider: new FakeDocsProvider(),
    emailProvider: new FakeEmailProvider(),
    jobQueue: new FakeJobQueue(),
  });
}

async function cleanDb() {
  await prisma.notificationLog.deleteMany();
  await prisma.document.deleteMany();
  await prisma.resource.deleteMany();
  await prisma.adminUser.deleteMany();
}

afterAll(async () => {
  await cleanDb();
  await prisma.$disconnect();
});

describe("POST /admin/documents/:id/verify", () => {
  beforeEach(cleanDb);

  it("sets status VERIFIED, logs reviewer + timestamp, and notifies the resource", async () => {
    const admin = await seedAdmin();
    const { resource, document } = await seedResourceWithDocument();
    const app = buildApp();
    const agent = request.agent(app);
    await loginAsAdmin(agent);

    const res = await agent.post(`/api/admin/documents/${document.id}/verify`).send();

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(document.id);
    expect(res.body.status).toBe("VERIFIED");
    expect(typeof res.body.reviewedAt).toBe("string");

    const updated = await prisma.document.findUniqueOrThrow({ where: { id: document.id } });
    expect(updated.status).toBe("VERIFIED");
    expect(updated.reviewedById).toBe(admin.id);
    expect(updated.reviewedAt).not.toBeNull();

    const log = await prisma.notificationLog.findFirstOrThrow({ where: { relatedId: document.id } });
    expect(log.eventType).toBe("DOCUMENT_VERIFIED");
    expect(log.recipientEmail).toBe(resource.email);
    expect(log.status).toBe("SENT");
  });
});

describe("POST /admin/documents/:id/reject", () => {
  beforeEach(cleanDb);

  it("sets status REJECTED with reason, logs reviewer + timestamp, and notifies the resource", async () => {
    const admin = await seedAdmin();
    const { resource, document } = await seedResourceWithDocument();
    const app = buildApp();
    const agent = request.agent(app);
    await loginAsAdmin(agent);

    const res = await agent
      .post(`/api/admin/documents/${document.id}/reject`)
      .send({ reason: "Blurry photo" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: document.id, status: "REJECTED", rejectionReason: "Blurry photo" });
    expect(typeof res.body.reviewedAt).toBe("string");

    const updated = await prisma.document.findUniqueOrThrow({ where: { id: document.id } });
    expect(updated.status).toBe("REJECTED");
    expect(updated.rejectionReason).toBe("Blurry photo");
    expect(updated.reviewedById).toBe(admin.id);
    expect(updated.reviewedAt).not.toBeNull();

    const log = await prisma.notificationLog.findFirstOrThrow({ where: { relatedId: document.id } });
    expect(log.eventType).toBe("DOCUMENT_REJECTED");
    expect(log.recipientEmail).toBe(resource.email);
    expect(log.status).toBe("SENT");
  });
});

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
//   POST /resource/documents/:type   (multipart/form-data; type = aadhaar|pan|photo|bank_proof|nda)
//   Response 200: { docType, status: "PENDING_REVIEW", uploadedAt }

const RESOURCE_EMAIL = "doc-resource@example.com";
const RESOURCE_PASSWORD = "doc-password";

async function seedResource() {
  const passwordHash = await bcrypt.hash(RESOURCE_PASSWORD, 10);
  return prisma.resource.create({
    data: { email: RESOURCE_EMAIL, passwordHash, name: "Doc Resource" },
  });
}

async function loginAsResource(agent: ReturnType<typeof request.agent>) {
  await agent.post("/api/auth/login").send({ email: RESOURCE_EMAIL, password: RESOURCE_PASSWORD });
}

const ADMIN_EMAIL = "doc-admin@example.com";
const ADMIN_PASSWORD = "doc-admin-password";

async function seedAdmin() {
  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
  return prisma.adminUser.create({
    data: { email: ADMIN_EMAIL, passwordHash, name: "Doc Admin" },
  });
}

async function loginAsAdmin(agent: ReturnType<typeof request.agent>) {
  await agent.post("/api/auth/login").send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
}

function buildApp(driveProvider = new FakeDriveProvider()) {
  return {
    app: createApp({
      sheetsProvider: new FakeSheetsProvider(),
      driveProvider,
      docsProvider: new FakeDocsProvider(),
      emailProvider: new FakeEmailProvider(),
      jobQueue: new FakeJobQueue(),
    }),
    driveProvider,
  };
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

describe("POST /resource/documents/:type", () => {
  beforeEach(cleanDb);

  it("creates a Document row as PENDING_REVIEW and returns docType/status/uploadedAt", async () => {
    const resource = await seedResource();
    const { app, driveProvider } = buildApp();
    const agent = request.agent(app);
    await loginAsResource(agent);

    const res = await agent
      .post("/api/resource/documents/aadhaar")
      .attach("file", Buffer.from("fake aadhaar content"), "aadhaar.pdf");

    expect(res.status).toBe(200);
    expect(res.body.docType).toBe("AADHAAR");
    expect(res.body.status).toBe("PENDING_REVIEW");
    expect(typeof res.body.uploadedAt).toBe("string");

    const doc = await prisma.document.findUniqueOrThrow({
      where: { resourceId_docType: { resourceId: resource.id, docType: "AADHAAR" } },
    });
    expect(doc.status).toBe("PENDING_REVIEW");
    expect(doc.fileUrl).toBeTruthy();
    expect(driveProvider.uploadedFiles).toHaveLength(1);
  });
});

// Traces to HLD §5.4 (step 3): "Rejected documents notify the resource by
// email; resource can re-upload, which resets status to pending_review and
// notifies the admin." And HLD §7: "Document re-uploaded after rejection |
// Admin | Resource re-uploads a previously rejected document."
//
// The LLD/HLD don't say *which* admin receives this (there can be several)
// — recipient chosen here is the admin who rejected it (Document.reviewedById),
// since that's the only admin identity already on the record; flagging this
// as an assumption, not a specified behavior.
describe("POST /resource/documents/:type — re-upload after rejection", () => {
  beforeEach(cleanDb);

  it("resets status to PENDING_REVIEW, clears the rejection, and notifies the rejecting admin", async () => {
    const resource = await seedResource();
    const admin = await prisma.adminUser.create({
      data: { email: "reject-admin@example.com", passwordHash: "x", name: "Reject Admin" },
    });
    const existing = await prisma.document.create({
      data: {
        resourceId: resource.id,
        docType: "PAN",
        fileUrl: "https://fake-drive.example.com/files/old-pan.pdf",
        status: "REJECTED",
        rejectionReason: "Blurry",
        reviewedById: admin.id,
        reviewedAt: new Date(),
      },
    });

    const { app } = buildApp();
    const agent = request.agent(app);
    await loginAsResource(agent);

    const res = await agent
      .post("/api/resource/documents/pan")
      .attach("file", Buffer.from("new pan content"), "pan-new.pdf");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("PENDING_REVIEW");

    const updated = await prisma.document.findUniqueOrThrow({ where: { id: existing.id } });
    expect(updated.status).toBe("PENDING_REVIEW");
    expect(updated.rejectionReason).toBeNull();

    const log = await prisma.notificationLog.findFirstOrThrow({ where: { relatedId: existing.id } });
    expect(log.eventType).toBe("DOCUMENT_REUPLOADED");
    expect(log.recipientEmail).toBe(admin.email);
    expect(log.status).toBe("SENT");
  });
});

// Traces to LLD §2.7:
//   GET /resource/documents
//   GET /admin/resources/:id/documents
//   Response 200: [{ id, docType, fileUrl, status, rejectionReason, reviewedAt, uploadedAt }]
//   id added per LLD §0.22 — POST /admin/documents/:id/verify and /reject
//   need a specific Document id, which this list didn't previously expose.
describe("GET /resource/documents", () => {
  beforeEach(cleanDb);

  it("lists the logged-in resource's own documents", async () => {
    const resource = await seedResource();
    const doc = await prisma.document.create({
      data: {
        resourceId: resource.id,
        docType: "PAN",
        fileUrl: "https://fake-drive.example.com/files/pan.pdf",
        status: "VERIFIED",
        reviewedAt: new Date("2026-08-12T00:00:00.000Z"),
      },
    });

    const { app } = buildApp();
    const agent = request.agent(app);
    await loginAsResource(agent);

    const res = await agent.get("/api/resource/documents");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        id: doc.id,
        docType: "PAN",
        fileUrl: doc.fileUrl,
        status: "VERIFIED",
        rejectionReason: null,
        reviewedAt: doc.reviewedAt!.toISOString(),
        uploadedAt: doc.uploadedAt.toISOString(),
      },
    ]);
  });

  it("never returns another resource's documents", async () => {
    const resource = await seedResource();
    const otherResource = await prisma.resource.create({
      data: { email: "other-doc-resource@example.com", passwordHash: "x", name: "Other Resource" },
    });
    await prisma.document.create({
      data: {
        resourceId: otherResource.id,
        docType: "NDA",
        fileUrl: "https://fake-drive.example.com/files/other-nda.pdf",
        status: "PENDING_REVIEW",
      },
    });
    void resource;

    const { app } = buildApp();
    const agent = request.agent(app);
    await loginAsResource(agent);

    const res = await agent.get("/api/resource/documents");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe("GET /admin/resources/:id/documents", () => {
  beforeEach(cleanDb);

  it("lists a specific resource's documents for admin review", async () => {
    const resource = await seedResource();
    const doc = await prisma.document.create({
      data: {
        resourceId: resource.id,
        docType: "AADHAAR",
        fileUrl: "https://fake-drive.example.com/files/aadhaar.pdf",
        status: "PENDING_REVIEW",
      },
    });
    await seedAdmin();

    const { app } = buildApp();
    const agent = request.agent(app);
    await loginAsAdmin(agent);

    const res = await agent.get(`/api/admin/resources/${resource.id}/documents`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        id: doc.id,
        docType: "AADHAAR",
        fileUrl: doc.fileUrl,
        status: "PENDING_REVIEW",
        rejectionReason: null,
        reviewedAt: null,
        uploadedAt: doc.uploadedAt.toISOString(),
      },
    ]);
  });
});

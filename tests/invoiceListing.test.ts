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

// Traces to LLD §2.4:
//   GET /admin/invoices?resourceId=&status=      (admin, filterable)
//   GET /resource/invoices                        (resource — always scoped to session)
//   Response 200: [{
//     id, invoiceNo, projectName, batch, amount, invoiceDate,
//     generationStatus, approvalStatus, driveDocUrl, declineReason, actionedAt
//   }]
//
// `status` is interpreted as generationStatus (LLD §0.8 — flagged, the
// unqualified param predates the generationStatus/approvalStatus split).

const ADMIN_EMAIL = "listing-admin@example.com";
const ADMIN_PASSWORD = "listing-admin-password";
const RESOURCE_A_EMAIL = "listing-resource-a@example.com";
const RESOURCE_A_PASSWORD = "listing-resource-a-password";

async function seedAdmin() {
  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
  return prisma.adminUser.create({ data: { email: ADMIN_EMAIL, passwordHash, name: "Listing Admin" } });
}

async function seedResourceA() {
  const passwordHash = await bcrypt.hash(RESOURCE_A_PASSWORD, 10);
  return prisma.resource.create({
    data: { email: RESOURCE_A_EMAIL, passwordHash, name: "Listing Resource A" },
  });
}

async function loginAsAdmin(agent: ReturnType<typeof request.agent>) {
  await agent.post("/api/auth/login").send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
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
  overrides: {
    generationStatus?: string;
    projectName?: string;
    amountConfirmationStatus?: string;
    driveDocUrl?: string;
  } = {}
) {
  const sheetRow = await prisma.sheetRow.create({
    data: {
      resourceEmail,
      resourceName: "Listing Resource",
      month: "2026-08",
      projectName: overrides.projectName ?? "Project Listing",
      batch: "BatchListing",
      role: "Developer",
      hours: 10,
      rate: 100,
      computedAmount: 1000,
      rawData: {},
    },
  });
  return prisma.invoice.create({
    data: {
      invoiceNo: `INV-LIST-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sheetRowId: sheetRow.id,
      resourceId,
      amount: 1000,
      generationStatus: (overrides.generationStatus as never) ?? "GENERATED",
      amountConfirmationStatus: (overrides.amountConfirmationStatus as never) ?? "PENDING",
      driveDocUrl: overrides.driveDocUrl ?? "https://fake-drive.example.com/files/generated.doc",
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

describe("GET /admin/invoices", () => {
  beforeEach(cleanDb);

  it("returns invoices in the LLD §2.4 shape, filterable by resourceId and status", async () => {
    await seedAdmin();
    const resourceA = await seedResourceA();
    const resourceB = await prisma.resource.create({ data: { email: "listing-resource-b@example.com", name: "B" } });

    const invA = await makeInvoice(resourceA.id, resourceA.email, { generationStatus: "GENERATED" });
    await makeInvoice(resourceB.id, resourceB.email, { generationStatus: "FAILED" });

    const app = buildApp();
    const agent = request.agent(app);
    await loginAsAdmin(agent);

    const all = await agent.get("/api/admin/invoices");
    expect(all.status).toBe(200);
    expect(all.body).toHaveLength(2);
    expect(all.body[0]).toMatchObject({
      invoiceNo: expect.any(String),
      projectName: "Project Listing",
      batch: "BatchListing",
      amount: 1000,
      generationStatus: expect.any(String),
      approvalStatus: expect.any(String),
    });

    const byResource = await agent.get(`/api/admin/invoices?resourceId=${resourceA.id}`);
    expect(byResource.body).toHaveLength(1);
    expect(byResource.body[0].id).toBe(invA.id);

    const byStatus = await agent.get("/api/admin/invoices?status=FAILED");
    expect(byStatus.body).toHaveLength(1);
    expect(byStatus.body[0].generationStatus).toBe("FAILED");
  });
});

describe("GET /resource/invoices", () => {
  beforeEach(cleanDb);

  it("returns only the session resource's own invoices", async () => {
    const resourceA = await seedResourceA();
    const resourceB = await prisma.resource.create({ data: { email: "listing-resource-b2@example.com", name: "B2" } });
    await makeInvoice(resourceA.id, resourceA.email);
    await makeInvoice(resourceB.id, resourceB.email);

    const app = buildApp();
    const agent = request.agent(app);
    await loginAsResourceA(agent);

    const res = await agent.get("/api/resource/invoices");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  // Traces to LLD §0.9 / §2.4: "driveDocUrl is withheld (null) to the
  // resource until amountConfirmationStatus = CONFIRMED — the document
  // already exists by then, just not exposed yet."
  it("withholds driveDocUrl while amountConfirmationStatus is PENDING, exposes it once CONFIRMED", async () => {
    const resourceA = await seedResourceA();
    const pendingInvoice = await makeInvoice(resourceA.id, resourceA.email, {
      amountConfirmationStatus: "PENDING",
      driveDocUrl: "https://fake-drive.example.com/files/pending.doc",
    });
    const confirmedInvoice = await makeInvoice(resourceA.id, resourceA.email, {
      projectName: "Project Listing Confirmed",
      amountConfirmationStatus: "CONFIRMED",
      driveDocUrl: "https://fake-drive.example.com/files/confirmed.doc",
    });

    const app = buildApp();
    const agent = request.agent(app);
    await loginAsResourceA(agent);

    const res = await agent.get("/api/resource/invoices");
    expect(res.status).toBe(200);

    const pendingBody = res.body.find((inv: { id: string }) => inv.id === pendingInvoice.id);
    expect(pendingBody.driveDocUrl).toBeNull();
    expect(pendingBody.amountConfirmationStatus).toBe("PENDING");

    const confirmedBody = res.body.find((inv: { id: string }) => inv.id === confirmedInvoice.id);
    expect(confirmedBody.driveDocUrl).toBe("https://fake-drive.example.com/files/confirmed.doc");
    expect(confirmedBody.amountConfirmationStatus).toBe("CONFIRMED");
  });
});

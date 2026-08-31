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

// Traces to LLD §2.3 / §0.20 (added for Phase 9 — no endpoint previously
// listed SheetRows, despite §2.3's generate endpoint assuming the client
// already has a list to select a range from; flagged to the user, confirmed,
// added to the LLD before building):
//   GET /admin/sheet-rows
//   Response 200: [{
//     id, resourceName, resourceEmail, projectName, batch, role,
//     hours, rate, computedAmount,
//     invoiceId: string | null, generationStatus: string | null
//   }]
//   Excludes removedFromSheet rows.

const ADMIN_EMAIL = "sheetrows-admin@example.com";
const ADMIN_PASSWORD = "sheetrows-admin-password";

async function seedAdmin() {
  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
  return prisma.adminUser.create({ data: { email: ADMIN_EMAIL, passwordHash, name: "Sheetrows Admin" } });
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

describe("GET /admin/sheet-rows", () => {
  beforeEach(cleanDb);

  it("lists SheetRows with their invoice status if generated, excluding removedFromSheet rows", async () => {
    await seedAdmin();
    const resource = await prisma.resource.create({
      data: { email: "sheetrows-resource@example.com", name: "Sheetrows Resource" },
    });

    // Row with no invoice yet — the Dashboard's "Not Generated" state.
    const ungenerated = await prisma.sheetRow.create({
      data: {
        resourceEmail: resource.email,
        resourceName: resource.name,
        month: "2026-08",
        projectName: "PDF",
        batch: "1",
        role: "Annotator",
        hours: 32,
        rate: 100,
        computedAmount: 3200,
        rawData: {},
      },
    });

    // Row already generated — has an Invoice.
    const generatedRow = await prisma.sheetRow.create({
      data: {
        resourceEmail: resource.email,
        resourceName: resource.name,
        month: "2026-08",
        projectName: "PDF",
        batch: "2",
        role: "Annotator",
        hours: 41,
        rate: 100,
        computedAmount: 4100,
        rawData: {},
      },
    });
    const invoice = await prisma.invoice.create({
      data: {
        invoiceNo: "INV-SHEETROWS-0001",
        sheetRowId: generatedRow.id,
        resourceId: resource.id,
        amount: 4100,
        generationStatus: "GENERATED",
      },
    });

    // Row removed from the sheet on a later sync — must not appear.
    await prisma.sheetRow.create({
      data: {
        resourceEmail: resource.email,
        resourceName: resource.name,
        month: "2026-08",
        projectName: "PDF",
        batch: "3",
        role: "Annotator",
        hours: 24,
        rate: 100,
        computedAmount: 2400,
        rawData: {},
        removedFromSheet: true,
      },
    });

    const app = buildApp();
    const agent = request.agent(app);
    await loginAsAdmin(agent);

    const res = await agent.get("/api/admin/sheet-rows");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);

    const ungeneratedBody = res.body.find((r: { id: string }) => r.id === ungenerated.id);
    expect(ungeneratedBody).toEqual({
      id: ungenerated.id,
      resourceName: resource.name,
      resourceEmail: resource.email,
      projectName: "PDF",
      batch: "1",
      role: "Annotator",
      hours: 32,
      rate: 100,
      computedAmount: 3200,
      invoiceId: null,
      generationStatus: null,
    });

    const generatedBody = res.body.find((r: { id: string }) => r.id === generatedRow.id);
    expect(generatedBody).toEqual({
      id: generatedRow.id,
      resourceName: resource.name,
      resourceEmail: resource.email,
      projectName: "PDF",
      batch: "2",
      role: "Annotator",
      hours: 41,
      rate: 100,
      computedAmount: 4100,
      invoiceId: invoice.id,
      generationStatus: "GENERATED",
    });
  });
});

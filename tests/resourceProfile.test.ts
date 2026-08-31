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

// Traces to LLD §2.6:
//   GET /resource/profile
//   Response 200: { name, email, address, contactNo, pan, beneficiaryName, accountNo, bankName, ifsc, bankLocked, onboardingCompleted }
// Needed for the frontend's /profile page (Phase 9) — not implemented yet;
// router.ts flagged this as "added in a later phase, test-first".
// onboardingCompleted added per LLD §0.21 — lets the frontend redirect a
// freshly logged-in resource to /onboarding vs /invoices.

const RESOURCE_EMAIL = "profile-resource@example.com";
const RESOURCE_PASSWORD = "profile-resource-password";

async function seedResource() {
  const passwordHash = await bcrypt.hash(RESOURCE_PASSWORD, 10);
  return prisma.resource.create({
    data: {
      email: RESOURCE_EMAIL,
      passwordHash,
      name: "Profile Resource",
      address: "12, Sector 3, Bengaluru",
      contactNo: "+91 98120 34210",
      pan: "ABCPG1234K",
      beneficiaryName: "Profile Resource",
      accountNo: "50110007842910",
      bankName: "HDFC Bank",
      ifsc: "HDFC0002100",
      bankLocked: true,
      onboardingCompleted: true,
    },
  });
}

async function loginAsResource(agent: ReturnType<typeof request.agent>) {
  await agent.post("/api/auth/login").send({ email: RESOURCE_EMAIL, password: RESOURCE_PASSWORD });
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
  await prisma.resource.deleteMany();
  await prisma.adminUser.deleteMany();
}

afterAll(async () => {
  await cleanDb();
  await prisma.$disconnect();
});

describe("GET /resource/profile", () => {
  beforeEach(cleanDb);

  it("returns the logged-in resource's own profile fields", async () => {
    const resource = await seedResource();
    const app = buildApp();
    const agent = request.agent(app);
    await loginAsResource(agent);

    const res = await agent.get("/api/resource/profile");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      name: resource.name,
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
  });

  it("returns 403 with no session (requireRole gate, LLD §2 preamble)", async () => {
    const app = buildApp();
    const res = await request(app).get("/api/resource/profile");

    expect(res.status).toBe(403);
  });
});

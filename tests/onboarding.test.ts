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
//   POST /resource/onboarding   (one-time; rejected if onboardingCompleted already true)
//   Request: { address, contactNo, pan, beneficiaryName, accountNo, bankName, ifsc }
//   Response 200: { onboardingCompleted: true, bankLocked: true }
//
// Per the Phase 5 scope correction in BuildPlan.md: onboarding sets
// profile/bank fields only — document upload is separate (LLD §2.7).

const RESOURCE_EMAIL = "onboarding-resource@example.com";
const RESOURCE_PASSWORD = "onboarding-password";

const ONBOARDING_BODY = {
  address: "123 Example St",
  contactNo: "9876543210",
  pan: "ABCDE1234F",
  beneficiaryName: "Onboarding Resource",
  accountNo: "1234567890",
  bankName: "Example Bank",
  ifsc: "EXAM0001234",
};

async function seedResource(overrides: { onboardingCompleted?: boolean } = {}) {
  const passwordHash = await bcrypt.hash(RESOURCE_PASSWORD, 10);
  return prisma.resource.create({
    data: {
      email: RESOURCE_EMAIL,
      passwordHash,
      name: "Onboarding Resource",
      onboardingCompleted: overrides.onboardingCompleted ?? false,
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
}

afterAll(async () => {
  await cleanDb();
  await prisma.$disconnect();
});

describe("POST /resource/onboarding", () => {
  beforeEach(cleanDb);

  it("sets onboardingCompleted = true, bankLocked = true, and saves the submitted fields", async () => {
    await seedResource();
    const app = buildApp();
    const agent = request.agent(app);
    await loginAsResource(agent);

    const res = await agent.post("/api/resource/onboarding").send(ONBOARDING_BODY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ onboardingCompleted: true, bankLocked: true });

    const resource = await prisma.resource.findUniqueOrThrow({ where: { email: RESOURCE_EMAIL } });
    expect(resource.onboardingCompleted).toBe(true);
    expect(resource.bankLocked).toBe(true);
    expect(resource.address).toBe(ONBOARDING_BODY.address);
    expect(resource.contactNo).toBe(ONBOARDING_BODY.contactNo);
    expect(resource.pan).toBe(ONBOARDING_BODY.pan);
    expect(resource.beneficiaryName).toBe(ONBOARDING_BODY.beneficiaryName);
    expect(resource.accountNo).toBe(ONBOARDING_BODY.accountNo);
    expect(resource.bankName).toBe(ONBOARDING_BODY.bankName);
    expect(resource.ifsc).toBe(ONBOARDING_BODY.ifsc);
  });

  it("rejects a second submission once onboarding is already completed", async () => {
    await seedResource({ onboardingCompleted: true });
    const app = buildApp();
    const agent = request.agent(app);
    await loginAsResource(agent);

    const res = await agent.post("/api/resource/onboarding").send(ONBOARDING_BODY);

    expect(res.status).toBe(403);
  });
});

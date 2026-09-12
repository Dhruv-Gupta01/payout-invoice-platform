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

  // Not spec, user-requested: format validation on the profile/bank fields
  // (previously any string was accepted for PAN/IFSC/account/contact no.).
  it("rejects a malformed PAN with 400 and does not save anything", async () => {
    await seedResource();
    const app = buildApp();
    const agent = request.agent(app);
    await loginAsResource(agent);

    const res = await agent.post("/api/resource/onboarding").send({ ...ONBOARDING_BODY, pan: "not-a-pan" });

    expect(res.status).toBe(400);
    expect(res.body.field).toBe("pan");

    const resource = await prisma.resource.findUniqueOrThrow({ where: { email: RESOURCE_EMAIL } });
    expect(resource.onboardingCompleted).toBe(false);
  });

  it("rejects a malformed IFSC code with 400", async () => {
    await seedResource();
    const app = buildApp();
    const agent = request.agent(app);
    await loginAsResource(agent);

    const res = await agent.post("/api/resource/onboarding").send({ ...ONBOARDING_BODY, ifsc: "TOOSHORT" });

    expect(res.status).toBe(400);
    expect(res.body.field).toBe("ifsc");
  });

  it("rejects an account number that isn't 9-18 digits", async () => {
    await seedResource();
    const app = buildApp();
    const agent = request.agent(app);
    await loginAsResource(agent);

    const res = await agent.post("/api/resource/onboarding").send({ ...ONBOARDING_BODY, accountNo: "123" });

    expect(res.status).toBe(400);
    expect(res.body.field).toBe("accountNo");
  });

  it("rejects a contact number that isn't a valid 10-digit Indian mobile number", async () => {
    await seedResource();
    const app = buildApp();
    const agent = request.agent(app);
    await loginAsResource(agent);

    const res = await agent.post("/api/resource/onboarding").send({ ...ONBOARDING_BODY, contactNo: "12345" });

    expect(res.status).toBe(400);
    expect(res.body.field).toBe("contactNo");
  });

  it("rejects a beneficiary name containing digits", async () => {
    await seedResource();
    const app = buildApp();
    const agent = request.agent(app);
    await loginAsResource(agent);

    const res = await agent
      .post("/api/resource/onboarding")
      .send({ ...ONBOARDING_BODY, beneficiaryName: "Resource123" });

    expect(res.status).toBe(400);
    expect(res.body.field).toBe("beneficiaryName");
  });

  it("rejects a missing required field with 400", async () => {
    await seedResource();
    const app = buildApp();
    const agent = request.agent(app);
    await loginAsResource(agent);

    const { address: _address, ...bodyWithoutAddress } = ONBOARDING_BODY;
    const res = await agent.post("/api/resource/onboarding").send(bodyWithoutAddress);

    expect(res.status).toBe(400);
    expect(res.body.field).toBe("address");
  });

  it("normalizes PAN/IFSC to uppercase and trims whitespace before saving", async () => {
    await seedResource();
    const app = buildApp();
    const agent = request.agent(app);
    await loginAsResource(agent);

    const res = await agent.post("/api/resource/onboarding").send({
      ...ONBOARDING_BODY,
      pan: " abcde1234f ",
      ifsc: " exam0001234 ",
    });

    expect(res.status).toBe(200);
    const resource = await prisma.resource.findUniqueOrThrow({ where: { email: RESOURCE_EMAIL } });
    expect(resource.pan).toBe("ABCDE1234F");
    expect(resource.ifsc).toBe("EXAM0001234");
  });
});

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
//   PUT /resource/profile
//   Request: { address?, contactNo?, pan?, beneficiaryName?, accountNo?, bankName?, ifsc? }
//   Response 200: { updated fields..., bankLocked: true }
//   Response 403: { error: "Details are locked. Ask your admin to unlock them." }
//     // allowed only if an open BankUnlockLog exists for this resource (unlockedAt set, editedAt null)
// LLD §2.5:
//   POST /admin/resources/:id/unlock-bank
//   Response 200: { resourceId, unlockedAt }
// HLD §5.5 (Bank Detail Unlock):
//   1. Admin unlocks → logged in BankUnlockLog, resource notified by email.
//   2. Resource's /profile becomes editable until they save.
//   3. On save: fields updated, bank_locked = true again, unlock log entry
//      closed (edited_at, re_locked_at).
// HLD §7, reminder from Phase 4: "Bank details unlocked | Resource | Admin clicks Unlock"

const ADMIN_EMAIL = "bankunlock-admin@example.com";
const ADMIN_PASSWORD = "bankunlock-admin-password";
const RESOURCE_EMAIL = "bankunlock-resource@example.com";
const RESOURCE_PASSWORD = "bankunlock-resource-password";

async function seedAdmin() {
  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
  return prisma.adminUser.create({
    data: { email: ADMIN_EMAIL, passwordHash, name: "Bank Unlock Admin" },
  });
}

async function seedResource() {
  const passwordHash = await bcrypt.hash(RESOURCE_PASSWORD, 10);
  return prisma.resource.create({
    data: { email: RESOURCE_EMAIL, passwordHash, name: "Bank Unlock Resource", bankLocked: true },
  });
}

async function loginAsAdmin(agent: ReturnType<typeof request.agent>) {
  await agent.post("/api/auth/login").send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
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
  await prisma.notificationLog.deleteMany();
  await prisma.bankUnlockLog.deleteMany();
  await prisma.resource.deleteMany();
  await prisma.adminUser.deleteMany();
}

afterAll(async () => {
  await cleanDb();
  await prisma.$disconnect();
});

describe("PUT /resource/profile — locked by default", () => {
  beforeEach(cleanDb);

  it("rejects with 403 when no open BankUnlockLog exists for the resource", async () => {
    await seedResource();
    const app = buildApp();
    const agent = request.agent(app);
    await loginAsResource(agent);

    const res = await agent.put("/api/resource/profile").send({ contactNo: "9999999999" });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Details are locked. Ask your admin to unlock them." });
  });
});

describe("Bank unlock/re-lock flow", () => {
  beforeEach(cleanDb);

  it("unlock creates a BankUnlockLog and notifies the resource; allows exactly one edit; then re-locks and rejects further edits", async () => {
    const admin = await seedAdmin();
    const resource = await seedResource();
    const app = buildApp();

    const adminAgent = request.agent(app);
    await loginAsAdmin(adminAgent);

    const unlockRes = await adminAgent.post(`/api/admin/resources/${resource.id}/unlock-bank`).send();
    expect(unlockRes.status).toBe(200);
    expect(unlockRes.body.resourceId).toBe(resource.id);
    expect(typeof unlockRes.body.unlockedAt).toBe("string");

    const log = await prisma.bankUnlockLog.findFirstOrThrow({ where: { resourceId: resource.id } });
    expect(log.unlockedById).toBe(admin.id);
    expect(log.editedAt).toBeNull();
    expect(log.reLockedAt).toBeNull();

    const notifLog = await prisma.notificationLog.findFirstOrThrow({ where: { relatedId: resource.id } });
    expect(notifLog.eventType).toBe("BANK_UNLOCKED");
    expect(notifLog.recipientEmail).toBe(resource.email);
    expect(notifLog.status).toBe("SENT");

    // Resource's window to edit is now open.
    const resourceAgent = request.agent(app);
    await loginAsResource(resourceAgent);

    const editRes = await resourceAgent.put("/api/resource/profile").send({ contactNo: "8888888888" });
    expect(editRes.status).toBe(200);
    expect(editRes.body).toMatchObject({ contactNo: "8888888888", bankLocked: true });

    const resourceAfterEdit = await prisma.resource.findUniqueOrThrow({ where: { id: resource.id } });
    expect(resourceAfterEdit.bankLocked).toBe(true);
    expect(resourceAfterEdit.contactNo).toBe("8888888888");

    const logAfterEdit = await prisma.bankUnlockLog.findUniqueOrThrow({ where: { id: log.id } });
    expect(logAfterEdit.editedAt).not.toBeNull();
    expect(logAfterEdit.reLockedAt).not.toBeNull();

    // Further edits are rejected again — the window closed.
    const secondEditRes = await resourceAgent.put("/api/resource/profile").send({ contactNo: "7777777777" });
    expect(secondEditRes.status).toBe(403);
  });
});

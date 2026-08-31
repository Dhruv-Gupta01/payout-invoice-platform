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

// Traces to LLD §0.25 / §2.1 / §2.5 (new, resolves the original
// [TBD: invite flow] deferral — resource-only, manual/admin-triggered,
// user-confirmed):
//   POST /admin/resources/:id/send-invite
//   Response 200: { resourceId, inviteExpiresAt: string }
//   // generates a fresh token (7-day expiry), invalidating any prior unused
//   // one — that's how "resend" works. Fires INVITE_SENT.
//
//   POST /auth/accept-invite
//   Request: { token: string, password: string }
//   Response 200: { id, email, name, role: "resource" }  (+ session cookie — same as login)
//   Response 400: { error: "Invalid or expired invite link" }

const ADMIN_EMAIL = "invite-admin@example.com";
const ADMIN_PASSWORD = "invite-admin-password";

async function seedAdmin() {
  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
  return prisma.adminUser.create({ data: { email: ADMIN_EMAIL, passwordHash, name: "Invite Admin" } });
}

async function loginAsAdmin(agent: ReturnType<typeof request.agent>) {
  await agent.post("/api/auth/login").send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
}

function buildApp() {
  const emailProvider = new FakeEmailProvider();
  return {
    app: createApp({
      sheetsProvider: new FakeSheetsProvider(),
      driveProvider: new FakeDriveProvider(),
      docsProvider: new FakeDocsProvider(),
      emailProvider,
      jobQueue: new FakeJobQueue(),
    }),
    emailProvider,
  };
}

async function cleanDb() {
  await prisma.notificationLog.deleteMany();
  await prisma.resource.deleteMany();
  await prisma.adminUser.deleteMany();
}

afterAll(async () => {
  await cleanDb();
  await prisma.$disconnect();
});

describe("POST /admin/resources/:id/send-invite", () => {
  beforeEach(cleanDb);

  it("sets a token with a 7-day expiry and fires INVITE_SENT to the resource's email", async () => {
    await seedAdmin();
    const resource = await prisma.resource.create({
      data: { email: "invitee@example.com", name: "Invitee Resource" },
    });

    const { app, emailProvider } = buildApp();
    const agent = request.agent(app);
    await loginAsAdmin(agent);

    const beforeCall = Date.now();
    const res = await agent.post(`/api/admin/resources/${resource.id}/send-invite`).send();
    expect(res.status).toBe(200);
    expect(res.body.resourceId).toBe(resource.id);
    expect(typeof res.body.inviteExpiresAt).toBe("string");

    const expiresAt = new Date(res.body.inviteExpiresAt).getTime();
    const daysOut = (expiresAt - beforeCall) / (1000 * 60 * 60 * 24);
    expect(daysOut).toBeGreaterThan(6.9);
    expect(daysOut).toBeLessThan(7.1);

    const updated = await prisma.resource.findUniqueOrThrow({ where: { id: resource.id } });
    expect(updated.inviteToken).not.toBeNull();
    expect(updated.inviteTokenExpiresAt).not.toBeNull();

    expect(emailProvider.sent).toEqual([
      { to: resource.email, eventType: "INVITE_SENT", relatedId: resource.id },
    ]);
  });

  it("calling it again generates a new token, invalidating the old one (resend)", async () => {
    await seedAdmin();
    const resource = await prisma.resource.create({
      data: { email: "resend-invitee@example.com", name: "Resend Invitee" },
    });

    const { app } = buildApp();
    const agent = request.agent(app);
    await loginAsAdmin(agent);

    await agent.post(`/api/admin/resources/${resource.id}/send-invite`).send();
    const first = await prisma.resource.findUniqueOrThrow({ where: { id: resource.id } });

    await agent.post(`/api/admin/resources/${resource.id}/send-invite`).send();
    const second = await prisma.resource.findUniqueOrThrow({ where: { id: resource.id } });

    expect(second.inviteToken).not.toBeNull();
    expect(second.inviteToken).not.toBe(first.inviteToken);
  });
});

describe("POST /auth/accept-invite", () => {
  beforeEach(cleanDb);

  it("sets the password, clears the token, and logs the resource in immediately", async () => {
    const resource = await prisma.resource.create({
      data: {
        email: "accepting@example.com",
        name: "Accepting Resource",
        inviteToken: "valid-token-123",
        inviteTokenExpiresAt: new Date(Date.now() + 1000 * 60 * 60), // 1 hour out
      },
    });

    const { app } = buildApp();
    const agent = request.agent(app);

    const res = await agent
      .post("/api/auth/accept-invite")
      .send({ token: "valid-token-123", password: "a-new-password-123" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: resource.id,
      email: resource.email,
      name: resource.name,
      role: "resource",
    });
    expect(res.headers["set-cookie"]).toBeDefined();

    const updated = await prisma.resource.findUniqueOrThrow({ where: { id: resource.id } });
    expect(updated.passwordHash).not.toBeNull();
    expect(updated.inviteToken).toBeNull();
    expect(updated.inviteTokenExpiresAt).toBeNull();

    // Logged in immediately — no separate login step required.
    const meRes = await agent.get("/api/auth/me");
    expect(meRes.status).toBe(200);
    expect(meRes.body.id).toBe(resource.id);

    // The new password actually works for a normal login too.
    const freshAgent = request.agent(app);
    const loginRes = await freshAgent
      .post("/api/auth/login")
      .send({ email: resource.email, password: "a-new-password-123" });
    expect(loginRes.status).toBe(200);
  });

  it("rejects with 400 for an unknown token", async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post("/api/auth/accept-invite")
      .send({ token: "nonexistent-token", password: "whatever-123" });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Invalid or expired invite link" });
  });

  it("rejects with 400 for an expired token", async () => {
    await prisma.resource.create({
      data: {
        email: "expired@example.com",
        name: "Expired Resource",
        inviteToken: "expired-token-456",
        inviteTokenExpiresAt: new Date(Date.now() - 1000 * 60), // 1 minute ago
      },
    });

    const { app } = buildApp();
    const res = await request(app)
      .post("/api/auth/accept-invite")
      .send({ token: "expired-token-456", password: "whatever-123" });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Invalid or expired invite link" });
  });
});

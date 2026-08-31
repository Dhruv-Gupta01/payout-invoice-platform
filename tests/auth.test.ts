import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { FakeSheetsProvider } from "../src/providers/fakes/FakeSheetsProvider";
import { FakeJobQueue } from "../src/queue/fakes/FakeJobQueue";
import { FakeDriveProvider } from "../src/providers/fakes/FakeDriveProvider";
import { FakeDocsProvider } from "../src/providers/fakes/FakeDocsProvider";
import { FakeEmailProvider } from "../src/providers/fakes/FakeEmailProvider";

// Traces to LLD §2.1 (Auth):
//   POST /auth/login
//   Request:  { email: string, password: string }
//   Response 200: { id, email, name, role: "admin" | "resource" }  (+ sets session cookie)
//   Response 401: { error: "Invalid credentials" }
//
// passwordHash is manually seeded here (per rule 6 — no invite flow yet).

const app = createApp({ sheetsProvider: new FakeSheetsProvider(), driveProvider: new FakeDriveProvider(), docsProvider: new FakeDocsProvider(), emailProvider: new FakeEmailProvider(), jobQueue: new FakeJobQueue() });

const ADMIN_EMAIL = "admin@example.com";
const ADMIN_PASSWORD = "correct-horse-battery-staple";

async function seedAdmin() {
  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
  return prisma.adminUser.create({
    data: {
      email: ADMIN_EMAIL,
      passwordHash,
      name: "Seeded Admin",
    },
  });
}

const RESOURCE_EMAIL = "resource@example.com";
const RESOURCE_PASSWORD = "another-correct-password";

async function seedResource() {
  const passwordHash = await bcrypt.hash(RESOURCE_PASSWORD, 10);
  return prisma.resource.create({
    data: {
      email: RESOURCE_EMAIL,
      passwordHash,
      name: "Seeded Resource",
    },
  });
}

afterAll(async () => {
  await prisma.adminUser.deleteMany();
  await prisma.resource.deleteMany();
  await prisma.$disconnect();
});

describe("POST /auth/login", () => {
  beforeEach(async () => {
    await prisma.adminUser.deleteMany();
    await prisma.resource.deleteMany();
  });

  it("returns 200 with { id, email, name, role } and sets a session cookie on correct credentials", async () => {
    const admin = await seedAdmin();

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: admin.id,
      email: ADMIN_EMAIL,
      name: "Seeded Admin",
      role: "admin",
    });
    expect(res.headers["set-cookie"]).toBeDefined();
  });

  it("returns 401 with { error: 'Invalid credentials' } on wrong password", async () => {
    await seedAdmin();

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: ADMIN_EMAIL, password: "wrong-password" });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Invalid credentials" });
  });

  it("returns 401 with { error: 'Invalid credentials' } for an unknown email", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "nobody@example.com", password: "irrelevant" });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Invalid credentials" });
  });

  it("logs in a Resource with correct credentials, returning role: 'resource'", async () => {
    const resource = await seedResource();

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: RESOURCE_EMAIL, password: RESOURCE_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: resource.id,
      email: RESOURCE_EMAIL,
      name: "Seeded Resource",
      role: "resource",
    });
    expect(res.headers["set-cookie"]).toBeDefined();
  });
});

// Traces to LLD §2.1:
//   GET /auth/me
//   Response 200: { id, email, name, role }
//   Response 401: { error: "Not authenticated" }
describe("GET /auth/me", () => {
  beforeEach(async () => {
    await prisma.adminUser.deleteMany();
    await prisma.resource.deleteMany();
  });

  it("returns the current session's user after login", async () => {
    const admin = await seedAdmin();
    const agent = request.agent(app);

    await agent.post("/api/auth/login").send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    const res = await agent.get("/api/auth/me");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: admin.id,
      email: ADMIN_EMAIL,
      name: "Seeded Admin",
      role: "admin",
    });
  });

  // LLD §2.1 specifies GET /auth/me generically ({ id, email, name, role }) —
  // not admin-only. A resource session must round-trip the same way (needed
  // for the frontend's resource-side pages — Profile/Invoices/Documents —
  // to survive a page refresh).
  it("returns the current session's user for a resource session too", async () => {
    const resource = await seedResource();
    const agent = request.agent(app);

    await agent
      .post("/api/auth/login")
      .send({ email: RESOURCE_EMAIL, password: RESOURCE_PASSWORD });
    const res = await agent.get("/api/auth/me");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: resource.id,
      email: RESOURCE_EMAIL,
      name: "Seeded Resource",
      role: "resource",
    });
  });

  it("returns 401 with { error: 'Not authenticated' } with no session", async () => {
    const res = await request(app).get("/api/auth/me");

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Not authenticated" });
  });
});

// Traces to LLD §2.1:
//   POST /auth/logout
//   Response 204
//
// Specified in the LLD from the start but never actually built — no route,
// no frontend button. Surfaced by the user asking "why is there no logout
// option" during manual testing.
describe("POST /auth/logout", () => {
  beforeEach(async () => {
    await prisma.adminUser.deleteMany();
    await prisma.resource.deleteMany();
  });

  it("destroys the session — /auth/me returns 401 afterward", async () => {
    await seedAdmin();
    const agent = request.agent(app);
    await agent.post("/api/auth/login").send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });

    const logoutRes = await agent.post("/api/auth/logout");
    expect(logoutRes.status).toBe(204);

    const meRes = await agent.get("/api/auth/me");
    expect(meRes.status).toBe(401);
  });

  it("returns 204 even with no session (idempotent)", async () => {
    const res = await request(app).post("/api/auth/logout");
    expect(res.status).toBe(204);
  });
});

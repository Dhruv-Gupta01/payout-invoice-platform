import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { FakeSheetsProvider } from "../src/providers/fakes/FakeSheetsProvider";
import { FakeJobQueue } from "../src/queue/fakes/FakeJobQueue";
import { FakeDriveProvider } from "../src/providers/fakes/FakeDriveProvider";
import { FakeDocsProvider } from "../src/providers/fakes/FakeDocsProvider";
import { FakeEmailProvider } from "../src/providers/fakes/FakeEmailProvider";

// Traces to LLD §2 (preamble to the API Contracts section):
//   "All `/admin/*` and `/resource/*` routes require a valid session;
//    middleware checks the session's role against the route namespace and
//    rejects (403) on mismatch."
//
// No concrete /admin/* or /resource/* business endpoints exist yet (those
// come in later phases) — this exercises the role-check middleware itself,
// mounted at the router prefix ahead of any routes under it.

const app = createApp({ sheetsProvider: new FakeSheetsProvider(), driveProvider: new FakeDriveProvider(), docsProvider: new FakeDocsProvider(), emailProvider: new FakeEmailProvider(), jobQueue: new FakeJobQueue() });

const ADMIN_EMAIL = "role-admin@example.com";
const ADMIN_PASSWORD = "admin-password-123";
const RESOURCE_EMAIL = "role-resource@example.com";
const RESOURCE_PASSWORD = "resource-password-123";

async function seedAdmin() {
  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
  return prisma.adminUser.create({
    data: { email: ADMIN_EMAIL, passwordHash, name: "Role Test Admin" },
  });
}

async function seedResource() {
  const passwordHash = await bcrypt.hash(RESOURCE_PASSWORD, 10);
  return prisma.resource.create({
    data: { email: RESOURCE_EMAIL, passwordHash, name: "Role Test Resource" },
  });
}

async function loginAsAdmin(agent: ReturnType<typeof request.agent>) {
  await agent.post("/api/auth/login").send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
}

async function loginAsResource(agent: ReturnType<typeof request.agent>) {
  await agent.post("/api/auth/login").send({ email: RESOURCE_EMAIL, password: RESOURCE_PASSWORD });
}

afterAll(async () => {
  await prisma.adminUser.deleteMany();
  await prisma.resource.deleteMany();
  await prisma.$disconnect();
});

describe("Role-check middleware", () => {
  it("rejects a resource-role session on an /admin/* route with 403", async () => {
    await seedResource();
    const agent = request.agent(app);
    await loginAsResource(agent);

    const res = await agent.get("/api/admin/anything");

    expect(res.status).toBe(403);
  });

  it("rejects an admin-role session on a /resource/* route with 403", async () => {
    await seedAdmin();
    const agent = request.agent(app);
    await loginAsAdmin(agent);

    const res = await agent.get("/api/resource/anything");

    expect(res.status).toBe(403);
  });
});

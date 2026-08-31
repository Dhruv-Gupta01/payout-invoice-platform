import { describe, it, expect, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";

// Traces to LLD §1 (Prisma Schema) — proves the DB connection works and a
// basic round-trip against the AdminUser model (create, then read back)
// succeeds. This is the Phase 0 scaffold test, not business logic.

const prisma = new PrismaClient();

describe("Phase 0: DB connection + model round-trip", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("creates an AdminUser and reads it back", async () => {
    const created = await prisma.adminUser.create({
      data: {
        email: "scaffold-test@example.com",
        passwordHash: "not-a-real-hash",
        name: "Scaffold Test Admin",
      },
    });

    const found = await prisma.adminUser.findUnique({
      where: { id: created.id },
    });

    expect(found).not.toBeNull();
    expect(found?.email).toBe("scaffold-test@example.com");

    await prisma.adminUser.delete({ where: { id: created.id } });
  });
});

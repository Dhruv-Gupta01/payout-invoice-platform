import { PrismaClient } from "@prisma/client";

// Shared Prisma client singleton, used by the app (and reused by tests to
// seed/clean data against the same connection pool).
export const prisma = new PrismaClient();

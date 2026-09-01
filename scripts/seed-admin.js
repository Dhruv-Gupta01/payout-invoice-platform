/* Dev-only: create a local admin login. Run: node scripts/seed-admin.js */
const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");

const prisma = new PrismaClient();

async function main() {
  const email = process.env.ADMIN_EMAIL || "admin@example.com";
  const password = process.env.ADMIN_PASSWORD || "admin123";
  const passwordHash = await bcrypt.hash(password, 10);
  const admin = await prisma.adminUser.upsert({
    where: { email },
    update: { passwordHash },
    create: { email, passwordHash, name: "Local Admin" },
  });
  console.log("Admin ready:", admin.email, "/ password:", password);
}

main().finally(() => prisma.$disconnect());

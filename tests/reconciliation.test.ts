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

// Traces to LLD §0.26 / §2.3:
//   POST /admin/reconciliation   (multipart CSV, field name "file")
//   Response 200: { matched, ambiguous, notPaid, unrecognizedRows }
//   Response 400: { error: "..." }
//
//   POST /admin/invoices/:invoiceId/mark-paid
//   Response 200: { invoiceId, paidAt }
//   Response 400: { error: "Invoice is not eligible to be marked paid" }
//
// Matching key: Credit Account No. + IFSC -> Resource, then Amount -> which
// eligible (GENERATED + APPROVED + paidAt null) invoice. Real bank sample
// columns: Sr. No, Txn Type, Credit Account No., Credit Account Name, IFSC,
// Amount, Narration (Narration always generic, per user, so unused).

const ADMIN_EMAIL = "recon-admin@example.com";
const ADMIN_PASSWORD = "recon-admin-password";

async function seedAdmin() {
  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
  return prisma.adminUser.create({ data: { email: ADMIN_EMAIL, passwordHash, name: "Recon Admin" } });
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

function csvOf(rows: string[]): Buffer {
  const header = "Sr. No,Txn Type,Credit Account No.,Credit Account Name,IFSC,Amount,Narration";
  return Buffer.from([header, ...rows].join("\n"), "utf-8");
}

let resourceCounter = 0;
async function seedResource(overrides: Partial<{ accountNo: string; ifsc: string; name: string }> = {}) {
  resourceCounter += 1;
  return prisma.resource.create({
    data: {
      email: `recon-resource-${resourceCounter}@example.com`,
      name: overrides.name ?? `Recon Resource ${resourceCounter}`,
      accountNo: overrides.accountNo ?? `100000000${resourceCounter}`,
      ifsc: overrides.ifsc ?? `BARB0LANK${resourceCounter}`,
    },
  });
}

let invoiceCounter = 0;
async function seedInvoice(
  resourceId: string,
  resourceEmail: string,
  amount: number,
  overrides: { generationStatus?: string; approvalStatus?: string; paidAt?: Date | null } = {}
) {
  invoiceCounter += 1;
  const sheetRow = await prisma.sheetRow.create({
    data: {
      resourceEmail,
      resourceName: "Recon Resource",
      month: "2026-08",
      projectName: "Project Recon",
      batch: `Batch-Recon-${invoiceCounter}`,
      role: "Developer",
      hours: 10,
      rate: 100,
      computedAmount: amount,
      rawData: {},
    },
  });
  return prisma.invoice.create({
    data: {
      invoiceNo: `INV-RECON-${String(invoiceCounter).padStart(4, "0")}`,
      sheetRowId: sheetRow.id,
      resourceId,
      amount,
      generationStatus: (overrides.generationStatus as never) ?? "GENERATED",
      approvalStatus: (overrides.approvalStatus as never) ?? "APPROVED",
      amountConfirmationStatus: "CONFIRMED",
      paidAt: overrides.paidAt ?? null,
      driveDocUrl: "https://fake-drive.example.com/files/recon.doc",
    },
  });
}

async function cleanDb() {
  await prisma.notificationLog.deleteMany();
  await prisma.document.deleteMany();
  await prisma.invoice.deleteMany();
  await prisma.sheetRow.deleteMany();
  await prisma.resource.deleteMany();
  await prisma.adminUser.deleteMany();
}

afterAll(async () => {
  await cleanDb();
  await prisma.$disconnect();
});

describe("POST /admin/reconciliation", () => {
  beforeEach(cleanDb);

  it("marks an unambiguous account+IFSC+amount match as paid", async () => {
    await seedAdmin();
    const resource = await seedResource({ accountNo: "18630100015331", ifsc: "BARB0LANKA" });
    const invoice = await seedInvoice(resource.id, resource.email, 16621);

    const { app, emailProvider } = buildApp();
    const agent = request.agent(app);
    await loginAsAdmin(agent);

    const csv = csvOf(['1,NEFT,18630100015331,Abhiraj Kumar Kashyap,BARB0LANKA,"16,621.00",Service Charges']);
    const res = await agent
      .post("/api/admin/reconciliation")
      .attach("file", csv, { filename: "recon.csv", contentType: "text/csv" });

    expect(res.status).toBe(200);
    expect(res.body.matched).toEqual([
      {
        invoiceId: invoice.id,
        invoiceNo: invoice.invoiceNo,
        resourceId: resource.id,
        resourceName: resource.name,
        amount: 16621,
        creditAccountNo: "18630100015331",
      },
    ]);
    expect(res.body.ambiguous).toEqual([]);
    expect(res.body.notPaid).toEqual([]);
    expect(res.body.unrecognizedRows).toEqual([]);

    const updated = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(updated.paidAt).not.toBeNull();

    expect(emailProvider.sent).toEqual([]); // matched, so no INVOICE_NOT_PAID
  });

  it("flags an ambiguous match (same resource, two eligible invoices at the same amount) without marking either paid", async () => {
    await seedAdmin();
    const resource = await seedResource({ accountNo: "50100602736731", ifsc: "HDFC0004434" });
    const invoiceA = await seedInvoice(resource.id, resource.email, 1108);
    const invoiceB = await seedInvoice(resource.id, resource.email, 1108);

    const { app } = buildApp();
    const agent = request.agent(app);
    await loginAsAdmin(agent);

    const csv = csvOf(["2,NEFT,50100602736731,Aiswarya Sajan,HDFC0004434,1108.00,Service Charges"]);
    const res = await agent
      .post("/api/admin/reconciliation")
      .attach("file", csv, { filename: "recon.csv", contentType: "text/csv" });

    expect(res.status).toBe(200);
    expect(res.body.matched).toEqual([]);
    expect(res.body.ambiguous).toHaveLength(1);
    const candidateIds = res.body.ambiguous[0].candidates.map((c: { invoiceId: string }) => c.invoiceId).sort();
    expect(candidateIds).toEqual([invoiceA.id, invoiceB.id].sort());
    expect(res.body.ambiguous[0].candidates).toEqual(
      expect.arrayContaining([
        { invoiceId: invoiceA.id, invoiceNo: invoiceA.invoiceNo },
        { invoiceId: invoiceB.id, invoiceNo: invoiceB.invoiceNo },
      ])
    );
    // Ambiguous invoices are held, not reported as "not paid" (already found a candidate row).
    expect(res.body.notPaid).toEqual([]);

    const a = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceA.id } });
    const b = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceB.id } });
    expect(a.paidAt).toBeNull();
    expect(b.paidAt).toBeNull();
  });

  it("reports an eligible invoice not found in the file as notPaid and emails ADMIN_NOTIFICATION_EMAIL, deduped on a repeat run", async () => {
    await seedAdmin();
    const resource = await seedResource();
    const invoice = await seedInvoice(resource.id, resource.email, 5000);

    const { app, emailProvider } = buildApp();
    const agent = request.agent(app);
    await loginAsAdmin(agent);

    const csv = csvOf(["1,NEFT,99999999999,Someone Else,HDFC0001234,1.00,Service Charges"]);

    const res1 = await agent
      .post("/api/admin/reconciliation")
      .attach("file", csv, { filename: "recon.csv", contentType: "text/csv" });
    expect(res1.status).toBe(200);
    expect(res1.body.notPaid).toEqual([
      {
        invoiceId: invoice.id,
        invoiceNo: invoice.invoiceNo,
        resourceId: resource.id,
        resourceName: resource.name,
        amount: 5000,
      },
    ]);
    expect(emailProvider.sent).toEqual([
      { to: process.env.ADMIN_NOTIFICATION_EMAIL, eventType: "INVOICE_NOT_PAID", relatedId: invoice.id },
    ]);

    // Re-running reconciliation (e.g. a later file) must not re-email the same still-unpaid invoice.
    const res2 = await agent
      .post("/api/admin/reconciliation")
      .attach("file", csv, { filename: "recon.csv", contentType: "text/csv" });
    expect(res2.status).toBe(200);
    expect(res2.body.notPaid).toHaveLength(1);
    expect(emailProvider.sent).toHaveLength(1); // still just the one send from the first run
  });

  it("reports rows with no matching resource, and rows for a known resource with no matching invoice amount, as unrecognizedRows", async () => {
    await seedAdmin();
    const resource = await seedResource({ accountNo: "51930100002681", ifsc: "BARB0CHAMBA" });
    await seedInvoice(resource.id, resource.email, 1383);

    const { app } = buildApp();
    const agent = request.agent(app);
    await loginAsAdmin(agent);

    const csv = csvOf([
      "1,NEFT,00000000000000,Nobody,XXXX0000000,500.00,Service Charges", // no matching resource
      "2,NEFT,51930100002681,Ajay Thakur,BARB0CHAMBA,999.00,Service Charges", // resource found, wrong amount
    ]);
    const res = await agent
      .post("/api/admin/reconciliation")
      .attach("file", csv, { filename: "recon.csv", contentType: "text/csv" });

    expect(res.status).toBe(200);
    expect(res.body.unrecognizedRows).toEqual([
      expect.objectContaining({ creditAccountNo: "00000000000000", reason: "no matching resource" }),
      expect.objectContaining({ creditAccountNo: "51930100002681", reason: "resource found but no matching invoice amount" }),
    ]);
  });

  it("does not consider a FLAGGED or already-paid invoice eligible", async () => {
    await seedAdmin();
    const resource = await seedResource({ accountNo: "70000000001", ifsc: "ICIC0000001" });
    const notGenerated = await seedInvoice(resource.id, resource.email, 2000, { generationStatus: "FLAGGED", approvalStatus: "NOT_APPLICABLE" });
    const alreadyPaid = await seedInvoice(resource.id, resource.email, 3000, { paidAt: new Date("2026-01-01") });

    const { app } = buildApp();
    const agent = request.agent(app);
    await loginAsAdmin(agent);

    const csv = csvOf([
      "1,NEFT,70000000001,Someone,ICIC0000001,2000.00,Service Charges",
      "2,NEFT,70000000001,Someone,ICIC0000001,3000.00,Service Charges",
    ]);
    const res = await agent
      .post("/api/admin/reconciliation")
      .attach("file", csv, { filename: "recon.csv", contentType: "text/csv" });

    expect(res.status).toBe(200);
    expect(res.body.matched).toEqual([]);
    expect(res.body.unrecognizedRows).toHaveLength(2);
    expect(res.body.unrecognizedRows.every((r: { reason: string }) => r.reason === "resource found but no matching invoice amount")).toBe(true);

    const stillFlagged = await prisma.invoice.findUniqueOrThrow({ where: { id: notGenerated.id } });
    expect(stillFlagged.paidAt).toBeNull();
    const stillPaid = await prisma.invoice.findUniqueOrThrow({ where: { id: alreadyPaid.id } });
    expect(stillPaid.paidAt?.toISOString()).toBe(new Date("2026-01-01").toISOString());
  });

  it("rejects with 400 when no file is attached", async () => {
    await seedAdmin();
    const { app } = buildApp();
    const agent = request.agent(app);
    await loginAsAdmin(agent);

    const res = await agent.post("/api/admin/reconciliation").send();
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Missing file" });
  });

  it("rejects with 400 when a required column is missing", async () => {
    await seedAdmin();
    const { app } = buildApp();
    const agent = request.agent(app);
    await loginAsAdmin(agent);

    const badCsv = Buffer.from("Sr. No,Amount\n1,100.00", "utf-8");
    const res = await agent
      .post("/api/admin/reconciliation")
      .attach("file", badCsv, { filename: "bad.csv", contentType: "text/csv" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Missing required column/);
  });
});

describe("POST /admin/invoices/:invoiceId/mark-paid", () => {
  beforeEach(cleanDb);

  it("marks an eligible invoice paid", async () => {
    await seedAdmin();
    const resource = await seedResource();
    const invoice = await seedInvoice(resource.id, resource.email, 1000);

    const { app } = buildApp();
    const agent = request.agent(app);
    await loginAsAdmin(agent);

    const res = await agent.post(`/api/admin/invoices/${invoice.id}/mark-paid`).send();
    expect(res.status).toBe(200);
    expect(res.body.invoiceId).toBe(invoice.id);
    expect(res.body.paidAt).not.toBeNull();

    const updated = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(updated.paidAt).not.toBeNull();
  });

  it("rejects with 400 for an invoice that isn't GENERATED+APPROVED", async () => {
    await seedAdmin();
    const resource = await seedResource();
    const invoice = await seedInvoice(resource.id, resource.email, 1000, {
      generationStatus: "FLAGGED",
      approvalStatus: "NOT_APPLICABLE",
    });

    const { app } = buildApp();
    const agent = request.agent(app);
    await loginAsAdmin(agent);

    const res = await agent.post(`/api/admin/invoices/${invoice.id}/mark-paid`).send();
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Invoice is not eligible to be marked paid" });
  });

  it("rejects with 400 for an invoice that's already been marked paid", async () => {
    await seedAdmin();
    const resource = await seedResource();
    const invoice = await seedInvoice(resource.id, resource.email, 1000, { paidAt: new Date("2026-01-01") });

    const { app } = buildApp();
    const agent = request.agent(app);
    await loginAsAdmin(agent);

    const res = await agent.post(`/api/admin/invoices/${invoice.id}/mark-paid`).send();
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Invoice is not eligible to be marked paid" });
  });
});

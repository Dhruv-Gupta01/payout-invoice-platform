import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../src/lib/prisma";
import { FakeDriveProvider } from "../src/providers/fakes/FakeDriveProvider";
import { FakeDocsProvider } from "../src/providers/fakes/FakeDocsProvider";
import { FakeEmailProvider } from "../src/providers/fakes/FakeEmailProvider";
import { processInvoiceJob } from "../src/worker/invoiceWorker";

// Traces to HLD §7 (Notifications table):
//   "Payout generated | Resource | End of successful generation job"
// and LLD §5 (worker pseudocode): notify('PAYOUT_GENERATED', ...) after
// the invoice is marked GENERATED.
// All sends are logged in NotificationLog (HLD §7): "event type, recipient,
// related record, timestamp, status ... so delivery can be verified."
//
// Renamed from INVOICE_GENERATED per LLD §0.9 (Phase 6.6) — same trigger
// point, but the resource is told their payout is ready, not that an
// invoice document exists (gate 1 hasn't passed yet, so no document link).
//
// Per the Phase 4 scope note in BuildPlan.md: this is the only one of the
// six original events whose trigger point exists yet — the other five are
// wired in their own phases (5, 6) alongside the endpoints they depend on.

async function cleanDb() {
  await prisma.notificationLog.deleteMany();
  await prisma.invoice.deleteMany();
  await prisma.sheetRow.deleteMany();
  await prisma.resource.deleteMany();
}

afterAll(async () => {
  await cleanDb();
  await prisma.$disconnect();
});

async function seedInvoice() {
  const resource = await prisma.resource.create({
    data: { email: "notify-resource@example.com", name: "Notify Resource" },
  });
  const sheetRow = await prisma.sheetRow.create({
    data: {
      resourceEmail: resource.email,
      resourceName: resource.name,
      month: "2026-08",
      projectName: "Project Notify",
      batch: "BatchNotify",
      role: "Developer",
      hours: 10,
      rate: 100,
      computedAmount: 1000,
      rawData: {},
    },
  });
  const invoice = await prisma.invoice.create({
    data: {
      invoiceNo: `INV-NOTIFY-${Date.now()}`,
      sheetRowId: sheetRow.id,
      resourceId: resource.id,
      amount: 1000,
      generationStatus: "QUEUED",
    },
  });
  return { resource, sheetRow, invoice };
}

describe("Payout generated notification", () => {
  beforeEach(cleanDb);

  it("fires PAYOUT_GENERATED against the EmailProvider at the end of a successful generation job, to the resource, and logs it SENT", async () => {
    const { invoice, resource } = await seedInvoice();
    const driveProvider = new FakeDriveProvider();
    const docsProvider = new FakeDocsProvider();
    const emailProvider = new FakeEmailProvider();

    await processInvoiceJob(invoice.id, { driveProvider, docsProvider, emailProvider });

    expect(emailProvider.sent).toEqual([
      { to: resource.email, eventType: "PAYOUT_GENERATED", relatedId: invoice.id },
    ]);

    const log = await prisma.notificationLog.findFirstOrThrow({ where: { relatedId: invoice.id } });
    expect(log.eventType).toBe("PAYOUT_GENERATED");
    expect(log.recipientEmail).toBe(resource.email);
    expect(log.relatedType).toBe("invoice");
    expect(log.status).toBe("SENT");
  });

  it("logs a failed send as FAILED and does not crash the triggering job", async () => {
    const { invoice, resource } = await seedInvoice();
    const driveProvider = new FakeDriveProvider();
    const docsProvider = new FakeDocsProvider();
    const emailProvider = new FakeEmailProvider();
    emailProvider.failNextSend();

    // Should not throw, even though the email send fails.
    await processInvoiceJob(invoice.id, { driveProvider, docsProvider, emailProvider });

    const updated = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(updated.generationStatus).toBe("GENERATED"); // job itself still succeeded

    const log = await prisma.notificationLog.findFirstOrThrow({ where: { relatedId: invoice.id } });
    expect(log.status).toBe("FAILED");
    expect(log.errorMessage).toBeTruthy();
    expect(log.recipientEmail).toBe(resource.email);
  });
});

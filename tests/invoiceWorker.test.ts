import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../src/lib/prisma";
import { FakeDriveProvider } from "../src/providers/fakes/FakeDriveProvider";
import { FakeDocsProvider } from "../src/providers/fakes/FakeDocsProvider";
import { FakeEmailProvider } from "../src/providers/fakes/FakeEmailProvider";
import { processInvoiceJob, processInvoiceJobWithRetries } from "../src/worker/invoiceWorker";

// Traces to LLD §5 (Job Queue — worker pseudocode):
//   fetch → copy template (if no driveFileId) → fill (Docs batchUpdate) →
//   share → mark GENERATED/PENDING.
// And LLD §6 (Job Queue Design — idempotent resume):
//   "drive_file_id is persisted immediately after the template copy step...
//    On retry, if a drive_file_id already exists, the copy step is skipped
//    and the job resumes from filling — preventing duplicate orphaned
//    Drive files."
// And LLD §5 retry/failure: "BullMQ retries (3 attempts, exponential
// backoff). After exhausting retries, catch and set generationStatus =
// 'FAILED', errorMessage." (backoff/scheduling itself is Phase 7 — this
// tests the same attempt-count and failure-marking behavior directly.)

async function cleanDb() {
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
    data: { email: "worker-resource@example.com", name: "Worker Resource" },
  });
  const sheetRow = await prisma.sheetRow.create({
    data: {
      resourceEmail: resource.email,
      resourceName: resource.name,
      month: "2026-08",
      projectName: "Project Worker",
      batch: "BatchWorker",
      role: "Developer",
      hours: 10,
      rate: 100,
      computedAmount: 1000,
      rawData: {},
    },
  });
  const invoice = await prisma.invoice.create({
    data: {
      invoiceNo: `INV-WORKER-${Date.now()}`,
      sheetRowId: sheetRow.id,
      resourceId: resource.id,
      amount: 1000,
      generationStatus: "QUEUED",
    },
  });
  return { resource, sheetRow, invoice };
}

describe("processInvoiceJob — successful run", () => {
  beforeEach(cleanDb);

  it("sets driveFileId, driveDocUrl, generationStatus = GENERATED, approvalStatus = PENDING", async () => {
    const { invoice, resource } = await seedInvoice();
    const driveProvider = new FakeDriveProvider();
    const docsProvider = new FakeDocsProvider();
    const emailProvider = new FakeEmailProvider();

    await processInvoiceJob(invoice.id, { driveProvider, docsProvider, emailProvider });

    const updated = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(updated.generationStatus).toBe("GENERATED");
    expect(updated.approvalStatus).toBe("PENDING");
    expect(updated.driveFileId).not.toBeNull();
    expect(updated.driveDocUrl).toContain(updated.driveFileId!);

    expect(driveProvider.copyTemplateCalls).toHaveLength(1);
    expect(driveProvider.shareCalls).toEqual([{ fileId: updated.driveFileId, email: resource.email }]);
    expect(docsProvider.calls).toHaveLength(1);

    // LLD §4 — real placeholder requests now get built and passed, not [].
    expect(docsProvider.calls[0].requests).toHaveLength(16);
    const requests = docsProvider.calls[0].requests as {
      replaceAllText: { containsText: { text: string }; replaceText: string };
    }[];
    const invoiceNoReq = requests.find((r) => r.replaceAllText.containsText.text === "{{INVOICE_NO}}");
    expect(invoiceNoReq?.replaceAllText.replaceText).toBe(invoice.invoiceNo);

    // invoiceDate gets set at generation time — previously never set at all,
    // which would have left {{INVOICE_DATE}} blank on a real invoice.
    expect(updated.invoiceDate).not.toBeNull();
  });
});

describe("processInvoiceJobWithRetries — resumes without re-copying", () => {
  beforeEach(cleanDb);

  it("does not call copyTemplate again on retry after fillTemplate throws post-copy", async () => {
    const { invoice } = await seedInvoice();
    const driveProvider = new FakeDriveProvider();
    const docsProvider = new FakeDocsProvider();
    const emailProvider = new FakeEmailProvider();
    docsProvider.failNextCalls(1); // first attempt's batchUpdate throws, after copy already succeeded

    await processInvoiceJobWithRetries(invoice.id, { driveProvider, docsProvider, emailProvider }, 3);

    const updated = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(updated.generationStatus).toBe("GENERATED");
    expect(driveProvider.copyTemplateCalls).toHaveLength(1); // not re-copied
    expect(docsProvider.calls).toHaveLength(2); // failed once, succeeded on retry
  });
});

describe("processInvoiceJobWithRetries — retries exhausted", () => {
  beforeEach(cleanDb);

  it("marks generationStatus = FAILED with errorMessage set after exhausting retries", async () => {
    const { invoice } = await seedInvoice();
    const driveProvider = new FakeDriveProvider();
    const docsProvider = new FakeDocsProvider();
    const emailProvider = new FakeEmailProvider();
    docsProvider.failNextCalls(999); // always fails

    await processInvoiceJobWithRetries(invoice.id, { driveProvider, docsProvider, emailProvider }, 3);

    const updated = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(updated.generationStatus).toBe("FAILED");
    expect(updated.errorMessage).toBeTruthy();
    expect(driveProvider.copyTemplateCalls).toHaveLength(1); // still only copied once across all attempts
    expect(docsProvider.calls).toHaveLength(3); // one per attempt
  });
});

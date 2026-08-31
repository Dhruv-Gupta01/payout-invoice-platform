import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import type { Worker } from "bullmq";
import type IORedis from "ioredis";
import { prisma } from "../src/lib/prisma";
import { createRedisConnection } from "../src/queue/redisConnection";
import { RealJobQueue } from "../src/queue/RealJobQueue";
import { startInvoiceWorker } from "../src/worker/realWorkerProcess";
import { DriveProvider } from "../src/providers/DriveProvider";
import { FakeDocsProvider } from "../src/providers/fakes/FakeDocsProvider";
import { FakeEmailProvider } from "../src/providers/fakes/FakeEmailProvider";

// Traces to LLD §6 (Job Queue Design) and HLD §6:
//   "Queue: BullMQ, backed by Redis." "Job payload: { invoiceId } only."
//   "Rate limiting: worker concurrency and a global rate limiter configured
//    to stay under Google API quota... preventing quota-driven failure
//    waves on large batches."
// Real Redis required (docker-compose `redis` service) — this is
// specifically the integration test the fake JobQueue couldn't cover.

async function seedInvoice(suffix: string) {
  const resource = await prisma.resource.create({
    data: { email: `queue-resource-${suffix}@example.com`, name: "Queue Resource" },
  });
  const sheetRow = await prisma.sheetRow.create({
    data: {
      resourceEmail: resource.email,
      resourceName: resource.name,
      month: "2026-08",
      projectName: `Project Queue ${suffix}`,
      batch: "BatchQueue",
      role: "Developer",
      hours: 10,
      rate: 100,
      computedAmount: 1000,
      rawData: {},
    },
  });
  return prisma.invoice.create({
    data: {
      invoiceNo: `INV-QUEUE-${suffix}-${Date.now()}`,
      sheetRowId: sheetRow.id,
      resourceId: resource.id,
      amount: 1000,
      generationStatus: "QUEUED",
    },
  });
}

async function waitForStatus(invoiceId: string, status: string, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    if (invoice.generationStatus === status) return invoice;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for invoice ${invoiceId} to reach ${status}`);
}

async function cleanDb() {
  await prisma.invoice.deleteMany();
  await prisma.sheetRow.deleteMany();
  await prisma.resource.deleteMany();
}

let connections: IORedis[] = [];
let workers: Worker[] = [];
let queues: RealJobQueue[] = [];

afterEach(async () => {
  await Promise.all(workers.map((w) => w.close()));
  await Promise.all(queues.map((q) => q.close()));
  await Promise.all(connections.map((c) => c.quit()));
  workers = [];
  queues = [];
  connections = [];
});

afterAll(async () => {
  await cleanDb();
  await prisma.$disconnect();
});

describe("Real BullMQ/Redis: enqueue → pick up → process", () => {
  beforeEach(cleanDb);

  it("a job enqueued via RealJobQueue is picked up and processed by a real BullMQ Worker", async () => {
    const invoice = await seedInvoice("basic");

    const queueConnection = createRedisConnection(process.env.REDIS_URL!);
    const workerConnection = createRedisConnection(process.env.REDIS_URL!);
    connections.push(queueConnection, workerConnection);

    const queue = new RealJobQueue(queueConnection);
    queues.push(queue);

    const driveProvider = new FakeDriveProviderForQueue();
    const worker = startInvoiceWorker({
      connection: workerConnection,
      deps: { driveProvider, docsProvider: new FakeDocsProvider(), emailProvider: new FakeEmailProvider() },
    });
    workers.push(worker);

    await queue.enqueueInvoiceJob(invoice.id);

    const updated = await waitForStatus(invoice.id, "GENERATED");
    expect(updated.generationStatus).toBe("GENERATED");
    expect(driveProvider.copyTemplateCalls).toBe(1);
  }, 15000);
});

describe("Real BullMQ/Redis: concurrency cap under a batch", () => {
  beforeEach(cleanDb);

  it("processes a batch of jobs without exceeding the configured concurrency", async () => {
    const BATCH_SIZE = 6;
    const CONCURRENCY = 2;

    const invoices = await Promise.all(
      Array.from({ length: BATCH_SIZE }, (_, i) => seedInvoice(`batch-${i}`))
    );

    const queueConnection = createRedisConnection(process.env.REDIS_URL!);
    const workerConnection = createRedisConnection(process.env.REDIS_URL!);
    connections.push(queueConnection, workerConnection);

    const queue = new RealJobQueue(queueConnection);
    queues.push(queue);

    const driveProvider = new ConcurrencyTrackingDriveProvider();
    const worker = startInvoiceWorker({
      connection: workerConnection,
      deps: { driveProvider, docsProvider: new FakeDocsProvider(), emailProvider: new FakeEmailProvider() },
      concurrency: CONCURRENCY,
      rateLimitMax: CONCURRENCY,
      rateLimitDurationMs: 300,
    });
    workers.push(worker);

    await Promise.all(invoices.map((inv) => queue.enqueueInvoiceJob(inv.id)));

    for (const inv of invoices) {
      await waitForStatus(inv.id, "GENERATED", 20000);
    }

    expect(driveProvider.peakConcurrent).toBeLessThanOrEqual(CONCURRENCY);
    expect(driveProvider.peakConcurrent).toBeGreaterThan(1); // proves concurrency > 1 actually happened, not accidentally serial
  }, 25000);
});

describe("Real BullMQ/Redis: retries exhausted", () => {
  beforeEach(cleanDb);

  it("marks the invoice FAILED via the worker's 'failed' handler after real BullMQ exhausts retries, without re-copying the template", async () => {
    const invoice = await seedInvoice("exhausted");

    const queueConnection = createRedisConnection(process.env.REDIS_URL!);
    const workerConnection = createRedisConnection(process.env.REDIS_URL!);
    connections.push(queueConnection, workerConnection);

    // Short backoff so exhausting 3 real BullMQ attempts doesn't slow the test down.
    const queue = new RealJobQueue(queueConnection, { attempts: 3, backoffDelayMs: 50 });
    queues.push(queue);

    const driveProvider = new FakeDriveProviderForQueue();
    const docsProvider = new FakeDocsProvider();
    docsProvider.failNextCalls(999); // always fails

    const worker = startInvoiceWorker({
      connection: workerConnection,
      deps: { driveProvider, docsProvider, emailProvider: new FakeEmailProvider() },
    });
    workers.push(worker);

    await queue.enqueueInvoiceJob(invoice.id);

    const updated = await waitForStatus(invoice.id, "FAILED", 20000);
    expect(updated.generationStatus).toBe("FAILED");
    expect(updated.errorMessage).toBeTruthy();
    expect(driveProvider.copyTemplateCalls).toBe(1); // not re-copied across the 3 real attempts
    expect(docsProvider.calls).toHaveLength(3); // one per attempt
  }, 25000);
});

describe("Real BullMQ/Redis: retries exhausted for an invoice that no longer exists", () => {
  beforeEach(cleanDb);

  // Real bug found live (src/worker/realWorkerProcess.ts): a stale/leftover
  // job whose Invoice was since deleted (e.g. a dev-DB reset that never
  // touched the Redis queue) hit an unguarded prisma.invoice.update inside
  // the 'failed' event handler — Prisma's P2025 there was an unhandled
  // promise rejection from a BullMQ listener, which crashes the entire
  // Node process by default, not just this one job. Fixed with a try/catch
  // that logs instead of throwing. Proven here the way an unhandled
  // rejection actually shows itself: not via an assertion (a crashed
  // process doesn't get to run its own expect() calls) but by the worker
  // staying alive and able to process a second, unrelated job afterward.
  it("logs instead of crashing the worker process, which keeps processing later jobs", async () => {
    const invoice = await seedInvoice("deleted-before-exhaustion");
    const survivor = await seedInvoice("survivor");

    const queueConnection = createRedisConnection(process.env.REDIS_URL!);
    const workerConnection = createRedisConnection(process.env.REDIS_URL!);
    connections.push(queueConnection, workerConnection);

    const queue = new RealJobQueue(queueConnection, { attempts: 2, backoffDelayMs: 50 });
    queues.push(queue);

    const driveProvider = new FakeDriveProviderForQueue();
    const docsProvider = new FakeDocsProvider();
    docsProvider.failNextCalls(999); // always fails, so this job's retries exhaust

    const worker = startInvoiceWorker({
      connection: workerConnection,
      deps: { driveProvider, docsProvider, emailProvider: new FakeEmailProvider() },
    });
    workers.push(worker);

    await queue.enqueueInvoiceJob(invoice.id);
    await prisma.invoice.delete({ where: { id: invoice.id } }); // gone before retries exhaust

    // Give the doomed job's retries (2 attempts, 50ms backoff) time to exhaust
    // and hit the 'failed' handler's now-guarded update.
    await new Promise((r) => setTimeout(r, 500));

    // The worker process must still be alive and responsive: a plain,
    // unrelated job enqueued afterward should still process normally.
    docsProvider.failNextCalls(0);
    await queue.enqueueInvoiceJob(survivor.id);
    const updated = await waitForStatus(survivor.id, "GENERATED", 10000);
    expect(updated.generationStatus).toBe("GENERATED");
  }, 20000);
});

// Instrumented fakes local to this integration test — track call counts
// and concurrency, which the standard FakeDriveProvider doesn't need to.
class FakeDriveProviderForQueue implements DriveProvider {
  public copyTemplateCalls = 0;
  async copyTemplate(): Promise<string> {
    this.copyTemplateCalls++;
    return "queue-test-file-id";
  }
  async shareWithEmail(): Promise<void> {}
  async uploadFile(): Promise<string> {
    return "unused";
  }
  async deleteFile(): Promise<void> {}
}

class ConcurrencyTrackingDriveProvider implements DriveProvider {
  public current = 0;
  public peakConcurrent = 0;
  private nextId = 1;

  async copyTemplate(): Promise<string> {
    this.current++;
    this.peakConcurrent = Math.max(this.peakConcurrent, this.current);
    await new Promise((r) => setTimeout(r, 250)); // hold the "slot" so concurrency is observable
    this.current--;
    return `tracked-file-${this.nextId++}`;
  }
  async shareWithEmail(): Promise<void> {}
  async uploadFile(): Promise<string> {
    return "unused";
  }
  async deleteFile(): Promise<void> {}
}

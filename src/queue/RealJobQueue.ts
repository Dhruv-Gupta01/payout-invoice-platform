import { Queue } from "bullmq";
import IORedis from "ioredis";
import { JobQueue } from "./JobQueue";
import { INVOICE_QUEUE_NAME } from "./queueNames";

export interface RealJobQueueOptions {
  attempts?: number;
  backoffDelayMs?: number;
}

// LLD §6: "Job payload: { invoiceId } only — all other data is fetched
// fresh from Postgres at execution time." "Retries: small fixed attempt
// count (e.g. 3) with exponential backoff." attempts/backoffDelayMs are
// overridable per instance so tests can use a short backoff instead of
// waiting out real exponential delays.
export class RealJobQueue implements JobQueue {
  private queue: Queue;
  private attempts: number;
  private backoffDelayMs: number;

  constructor(connection: IORedis, options: RealJobQueueOptions = {}) {
    this.queue = new Queue(INVOICE_QUEUE_NAME, { connection });
    this.attempts = options.attempts ?? 3;
    this.backoffDelayMs = options.backoffDelayMs ?? 1000;
  }

  async enqueueInvoiceJob(invoiceId: string): Promise<void> {
    await this.queue.add(
      "generate-invoice",
      { invoiceId },
      { attempts: this.attempts, backoff: { type: "exponential", delay: this.backoffDelayMs } }
    );
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}

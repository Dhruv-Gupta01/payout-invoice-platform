import { JobQueue } from "../JobQueue";

// In-memory fake: records what was enqueued, doesn't process anything.
// Real BullMQ processing is Phase 7; the worker function itself
// (processInvoiceJob) is tested directly, independent of any queue.
export class FakeJobQueue implements JobQueue {
  public enqueued: string[] = [];

  async enqueueInvoiceJob(invoiceId: string): Promise<void> {
    this.enqueued.push(invoiceId);
  }
}

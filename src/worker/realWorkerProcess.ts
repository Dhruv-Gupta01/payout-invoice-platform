import { Worker } from "bullmq";
import IORedis from "ioredis";
import { prisma } from "../lib/prisma";
import { INVOICE_QUEUE_NAME } from "../queue/queueNames";
import { processInvoiceJob, WorkerDependencies } from "./invoiceWorker";

// LLD §6: "Rate limiting: worker concurrency and a global rate limiter
// configured to stay under Google API quota (Docs/Drive), preventing
// quota-driven failure waves on large batches." No specific numbers are
// given anywhere in the LLD/HLD — these are placeholder tuning values,
// not derived from an actual Google API quota tier (that's only known once
// the real service account exists, Phase 8). Override via env vars.
const DEFAULT_CONCURRENCY = Number(process.env.WORKER_CONCURRENCY ?? 3);
const DEFAULT_RATE_LIMIT_MAX = Number(process.env.WORKER_RATE_LIMIT_MAX ?? 5);
const DEFAULT_RATE_LIMIT_DURATION_MS = Number(process.env.WORKER_RATE_LIMIT_DURATION_MS ?? 1000);

export interface RealWorkerOptions {
  connection: IORedis;
  deps: WorkerDependencies;
  concurrency?: number;
  rateLimitMax?: number;
  rateLimitDurationMs?: number;
}

// LLD §5: "On unhandled error: BullMQ retries (configured: 3 attempts,
// exponential backoff). After exhausting retries, catch and set
// generationStatus = 'FAILED', errorMessage." The processor itself just
// throws on failure (letting BullMQ's own retry mechanism re-run the job,
// per the `attempts`/`backoff` set on the job in RealJobQueue); marking
// FAILED after the last attempt is handled in the 'failed' event below.
export function startInvoiceWorker(options: RealWorkerOptions): Worker {
  const worker = new Worker(
    INVOICE_QUEUE_NAME,
    async (job) => {
      const { invoiceId } = job.data as { invoiceId: string };
      await processInvoiceJob(invoiceId, options.deps);
    },
    {
      connection: options.connection,
      concurrency: options.concurrency ?? DEFAULT_CONCURRENCY,
      limiter: {
        max: options.rateLimitMax ?? DEFAULT_RATE_LIMIT_MAX,
        duration: options.rateLimitDurationMs ?? DEFAULT_RATE_LIMIT_DURATION_MS,
      },
    }
  );

  // Real bug found live (not caught by tests, which only exercise this
  // against invoices that still exist): an unhandled rejection here — e.g.
  // Prisma's P2025 when the invoice a stale/leftover job points at has since
  // been deleted (a dev-DB reset, this queue was never flushed to match) —
  // is an unhandled promise rejection from a BullMQ event listener. Node
  // treats that as fatal by default, crashing the *entire* process, taking
  // down the API for every other request in flight too — the same class of
  // bug as the unguarded-route crash fixed earlier (src/lib/asyncHandler.ts),
  // just in the worker's event handler instead of an Express route. Fixed:
  // catch and log rather than let it propagate.
  worker.on("failed", async (job, err) => {
    if (!job) return;
    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade >= maxAttempts) {
      try {
        await prisma.invoice.update({
          where: { id: (job.data as { invoiceId: string }).invoiceId },
          data: {
            generationStatus: "FAILED",
            errorMessage: err instanceof Error ? err.message : String(err),
          },
        });
      } catch (updateErr) {
        console.error(
          `[worker] Could not mark invoice ${(job.data as { invoiceId: string }).invoiceId} FAILED after exhausting retries — record may no longer exist:`,
          updateErr
        );
      }
    }
  });

  return worker;
}

// Behind-an-interface boundary for BullMQ/Redis (HLD §6, LLD §5). Real
// implementation is wired in Phase 7 ("Queue Wiring"); until then this is
// only ever the in-memory fake — no real Redis in tests or earlier phases.
export interface JobQueue {
  enqueueInvoiceJob(invoiceId: string): Promise<void>;
}

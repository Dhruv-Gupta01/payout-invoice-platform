import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { ResourceSidebar } from "@/components/ops/ResourceSidebar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { inr } from "@/data/rows";
import { api } from "@/lib/api";

export const Route = createFileRoute("/invoices")({
  head: () => ({
    meta: [
      { title: "My Invoices — Payouts Console" },
      {
        name: "description",
        content: "View your invoices and payout status.",
      },
      { property: "og:title", content: "My Invoices — Payouts Console" },
      {
        property: "og:description",
        content: "View your invoices and payout status.",
      },
    ],
  }),
  component: InvoicesPage,
});

// LLD §2.4 (GET /resource/invoices) response shape.
type ResourceInvoice = {
  id: string;
  invoiceNo: string;
  projectName: string;
  batch: string;
  amount: number;
  invoiceDate: string | null;
  generationStatus: "FLAGGED" | "QUEUED" | "PROCESSING" | "GENERATED" | "FAILED";
  amountConfirmationStatus: "PENDING" | "CONFIRMED" | "REJECTED";
  approvalStatus: "NOT_APPLICABLE" | "PENDING" | "APPROVED" | "DECLINED";
  driveDocUrl: string | null;
  declineReason: string | null;
  actionedAt: string | null;
};

function formatActionedAt(iso?: string | null) {
  if (!iso) return "";
  const d = new Date(iso);
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const h24 = d.getUTCHours();
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ampm = h24 < 12 ? "AM" : "PM";
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()} at ${h}:${mm} ${ampm}`;
}

// The resource's first signal that an invoice exists at all is the
// PAYOUT_GENERATED email, sent only once generationStatus reaches GENERATED
// (LLD §0.9). Before that, amountConfirmationStatus/approvalStatus already
// sit at their default PENDING/NOT_APPLICABLE values — showing gate 1 UI for
// a row still QUEUED/PROCESSING/FLAGGED/FAILED would surface an invoice the
// resource was never told about (and, for FLAGGED/FAILED, one the admin
// hasn't resolved yet). Not explicitly specified; flagging this filter as
// the assumption rather than deciding silently in a way nobody can see.
function useInvoices() {
  return useQuery({
    queryKey: ["resource", "invoices"],
    queryFn: async () => {
      const invoices = await api.get<ResourceInvoice[]>("/resource/invoices");
      return invoices.filter((invoice) => invoice.generationStatus === "GENERATED");
    },
  });
}

function InvoicesPage() {
  const { data, isLoading, isError, refetch } = useInvoices();

  return (
    <div className="min-h-screen bg-background">
      <ResourceSidebar active="My Invoices" />
      <main className="pt-14 pb-16 tab:ml-[220px] tab:pt-0 tab:pb-0">
        <header className="flex flex-col gap-2 border-b border-border px-4 py-4 tab:h-14 tab:flex-row tab:items-center tab:justify-between tab:px-8 tab:py-0">
          <h1 className="text-[28px] leading-none font-medium tracking-tight">My invoices</h1>
        </header>
        <div className="px-4 py-6 tab:px-8">
          {isLoading ? (
            <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Loading your invoices…
            </div>
          ) : isError ? (
            <div className="flex max-w-3xl flex-col items-start gap-3 rounded-md border border-destructive/25 bg-destructive/10 px-6 py-8 text-[13px] text-destructive">
              <p>Couldn't load your invoices. Please try again.</p>
              <Button size="sm" variant="outline" onClick={() => refetch()}>
                Retry
              </Button>
            </div>
          ) : !data || data.length === 0 ? (
            <div className="fade-in-150 flex max-w-3xl flex-col items-center justify-center rounded-md border border-border bg-card px-6 py-16 text-center tab:px-8">
              <p className="text-[14px] font-medium text-foreground">No invoices yet</p>
              <p className="mt-1 text-[13px] text-muted-foreground">
                Your invoices will appear here once generated
              </p>
            </div>
          ) : (
            <div className="grid max-w-3xl gap-4">
              {data.map((invoice) => (
                <InvoiceCard key={invoice.id} invoice={invoice} />
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

function GateBadge({ label, tone }: { label: string; tone: "warning" | "success" | "destructive" | "muted" }) {
  const styles = {
    warning: "border-warning/25 bg-warning/10 text-warning",
    success: "border-success/25 bg-success/10 text-success",
    destructive: "border-destructive/25 bg-destructive/10 text-destructive",
    muted: "border-border bg-muted text-muted-foreground",
  };
  return (
    <span
      className={`fade-in-150 inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${styles[tone]}`}
    >
      {label}
    </span>
  );
}

function InvoiceCard({ invoice }: { invoice: ResourceInvoice }) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState("");
  const [showReasonFor, setShowReasonFor] = useState<"reject-amount" | "decline" | null>(null);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["resource", "invoices"] });

  const confirmAmount = useMutation({
    mutationFn: () => api.post(`/resource/invoices/${invoice.id}/confirm-amount`),
    onSuccess: invalidate,
  });
  const rejectAmount = useMutation({
    mutationFn: () => api.post(`/resource/invoices/${invoice.id}/reject-amount`, { reason: reason.trim() || undefined }),
    onSuccess: () => {
      setShowReasonFor(null);
      setReason("");
      invalidate();
    },
  });
  const approve = useMutation({
    mutationFn: () => api.post(`/resource/invoices/${invoice.id}/approve`),
    onSuccess: invalidate,
  });
  const decline = useMutation({
    mutationFn: () => api.post(`/resource/invoices/${invoice.id}/decline`, { reason: reason.trim() || undefined }),
    onSuccess: () => {
      setShowReasonFor(null);
      setReason("");
      invalidate();
    },
  });

  const busy = confirmAmount.isPending || rejectAmount.isPending || approve.isPending || decline.isPending;

  // Gate 1 (LLD §0.9): amount confirmation, before the document is ever shown.
  const gate1Pending = invoice.amountConfirmationStatus === "PENDING";
  const gate1Rejected = invoice.amountConfirmationStatus === "REJECTED";
  // Gate 2: document review, only reachable once gate 1 is CONFIRMED.
  const gate2Pending = invoice.amountConfirmationStatus === "CONFIRMED" && invoice.approvalStatus === "PENDING";
  const approved = invoice.approvalStatus === "APPROVED";
  const declined = invoice.approvalStatus === "DECLINED";

  return (
    <div className="rounded-md border border-border bg-card p-4 transition-opacity duration-150 tab:p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-[14px] font-medium text-foreground">
            {invoice.projectName} — Batch {invoice.batch}
          </div>
          <div className="mt-1 text-[12px] text-muted-foreground">Invoice #{invoice.invoiceNo}</div>
        </div>
        <div className="text-right">
          <div className="num text-[18px] font-medium leading-none text-foreground">
            {inr(invoice.amount)}
          </div>
        </div>
      </div>

      <div className="mt-4 flex items-center justify-between gap-4">
        {gate1Pending && <GateBadge label="Confirm your amount" tone="warning" />}
        {gate1Rejected && <GateBadge label="Amount rejected — held for admin" tone="destructive" />}
        {gate2Pending && <GateBadge label="Review your invoice" tone="warning" />}
        {approved && <GateBadge label="Approved" tone="success" />}
        {declined && <GateBadge label="Declined" tone="destructive" />}

        {/* driveDocUrl is withheld by the backend until gate 1 is CONFIRMED (LLD §0.9) */}
        {invoice.driveDocUrl && (
          <a
            href={invoice.driveDocUrl}
            className="text-[13px] text-primary hover:underline"
            target="_blank"
            rel="noreferrer"
          >
            View invoice
          </a>
        )}
      </div>

      {gate1Pending && (
        <div className="mt-4 flex flex-col gap-3">
          <p className="text-[12px] text-muted-foreground">
            Confirm the payout amount above is correct. Confirming makes the invoice document
            visible for your review.
          </p>
          <div className="flex flex-col gap-2 tab:flex-row tab:items-center tab:gap-3">
            <Button
              size="sm"
              disabled={busy}
              onClick={() => confirmAmount.mutate()}
              className="h-11 w-full tab:h-8 tab:w-auto"
            >
              {confirmAmount.isPending && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
              Confirm amount
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              className="h-11 w-full border-destructive text-destructive hover:bg-destructive/10 tab:h-8 tab:w-auto"
              onClick={() => setShowReasonFor(showReasonFor === "reject-amount" ? null : "reject-amount")}
            >
              Reject amount
            </Button>
          </div>
          {showReasonFor === "reject-amount" && (
            <div className="fade-in-150 flex flex-col gap-2 sm:flex-row sm:items-center">
              <Input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Add a reason (optional)"
                className="h-11 text-[13px] tab:h-8 sm:flex-1"
              />
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                className="border-destructive text-destructive hover:bg-destructive/10"
                onClick={() => rejectAmount.mutate()}
              >
                {rejectAmount.isPending && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
                Confirm rejection
              </Button>
            </div>
          )}
        </div>
      )}

      {gate1Rejected && (
        <div className="mt-4 text-[12px] text-muted-foreground">
          You rejected this amount{invoice.actionedAt ? ` on ${formatActionedAt(invoice.actionedAt)}` : ""}.
          Your admin needs to correct and reprocess this invoice before you can act on it again.
        </div>
      )}

      {gate2Pending && (
        <div className="mt-4 flex flex-col gap-3">
          <div className="flex flex-col gap-2 tab:flex-row tab:items-center tab:gap-3">
            <Button
              size="sm"
              disabled={busy}
              onClick={() => approve.mutate()}
              className="h-11 w-full tab:h-8 tab:w-auto"
            >
              {approve.isPending && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
              Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              className="h-11 w-full border-destructive text-destructive hover:bg-destructive/10 tab:h-8 tab:w-auto"
              onClick={() => setShowReasonFor(showReasonFor === "decline" ? null : "decline")}
            >
              Decline
            </Button>
          </div>
          {showReasonFor === "decline" && (
            <div className="fade-in-150 flex flex-col gap-2 sm:flex-row sm:items-center">
              <Input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Add a reason (optional)"
                className="h-11 text-[13px] tab:h-8 sm:flex-1"
              />
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                className="border-destructive text-destructive hover:bg-destructive/10"
                onClick={() => decline.mutate()}
              >
                {decline.isPending && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
                Confirm decline
              </Button>
            </div>
          )}
        </div>
      )}

      {(approved || declined) && (
        <div className="mt-4 text-[12px] text-muted-foreground">
          {approved ? "Approved" : "Declined"} on {formatActionedAt(invoice.actionedAt)}
          {declined && invoice.declineReason && (
            <span className="block mt-0.5">Reason: {invoice.declineReason}</span>
          )}
        </div>
      )}
    </div>
  );
}

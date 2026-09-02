import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Loader2 } from "lucide-react";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AppSidebar } from "@/components/ops/AppSidebar";
import { DocumentsSection, type DocumentItem } from "@/components/ops/DocumentsSection";
import { MobileCard, MobileField } from "@/components/ops/MobileRow";

import { Button } from "@/components/ui/button";
import { inr } from "@/data/rows";
import { api } from "@/lib/api";

export const Route = createFileRoute("/resources/$id")({
  head: () => ({
    meta: [
      { title: "Resource detail — Payouts Console" },
      {
        name: "description",
        content: "Contact details, bank details and full invoice history for a freelance resource.",
      },
      { property: "og:title", content: "Resource detail — Payouts Console" },
      {
        property: "og:description",
        content: "Invoice history and payout details for a freelance resource.",
      },
    ],
  }),
  component: ResourceDetail,
});

// LLD §2.4 (admin's ungated shape — driveDocUrl is never withheld here).
type AdminInvoice = {
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
  amountRejectionReason: string | null;
  actionedAt: string | null;
};

// LLD §2.5: GET /admin/resources/:id
type ResourceDetailResponse = {
  id: string;
  name: string;
  email: string;
  address: string | null;
  contactNo: string | null;
  pan: string | null;
  beneficiaryName: string | null;
  accountNo: string | null;
  bankName: string | null;
  ifsc: string | null;
  bankLocked: boolean;
  onboardingCompleted: boolean;
  accountActivated: boolean;
  inviteExpiresAt: string | null;
  invoices: AdminInvoice[];
  documents: DocumentItem[];
};

const th = "px-3 py-2 text-left text-[12px] font-medium text-muted-foreground";
const td = "px-3 text-[13px] text-foreground";

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <div className="mb-1 text-[12px] text-muted-foreground">{label}</div>
      <div className="text-[14px] text-foreground">{value || "—"}</div>
    </div>
  );
}

const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function formatActionDate(iso: string | null) {
  if (!iso) return "";
  const d = new Date(iso);
  const h24 = d.getUTCHours();
  const ampm = h24 >= 12 ? "PM" : "AM";
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${d.getUTCDate()} ${monthNames[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${h}:${mm} ${ampm}`;
}

// One "Reason" cell for both rejection paths: a gate-2 decline (declineReason)
// or a gate-1 amount rejection (amountRejectionReason).
function invoiceReason(inv: AdminInvoice): string {
  if (inv.approvalStatus === "DECLINED") return inv.declineReason ?? "";
  if (inv.amountConfirmationStatus === "REJECTED") {
    return inv.amountRejectionReason
      ? `Amount rejected: ${inv.amountRejectionReason}`
      : "Amount rejected";
  }
  return "";
}

// Same generic badge as the invoices list — this table shows both
// generationStatus (pre-generation) and, once generated, the approval
// outcome. Not gated (admin sees driveDocUrl/status unconditionally).
function statusLabel(inv: AdminInvoice): { label: string; tone: "warning" | "success" | "destructive" | "muted" } {
  if (inv.generationStatus !== "GENERATED") {
    return { label: inv.generationStatus === "FAILED" ? "Failed" : inv.generationStatus === "FLAGGED" ? "Flagged" : "Generating", tone: inv.generationStatus === "FAILED" || inv.generationStatus === "FLAGGED" ? "destructive" : "muted" };
  }
  if (inv.amountConfirmationStatus === "PENDING") return { label: "Awaiting amount confirmation", tone: "warning" };
  if (inv.amountConfirmationStatus === "REJECTED") return { label: "Amount rejected", tone: "destructive" };
  if (inv.approvalStatus === "APPROVED") return { label: "Approved", tone: "success" };
  if (inv.approvalStatus === "DECLINED") return { label: "Declined", tone: "destructive" };
  return { label: "Awaiting review", tone: "warning" };
}

function InvoiceStatusBadge({ invoice }: { invoice: AdminInvoice }) {
  const { label, tone } = statusLabel(invoice);
  const styles = {
    warning: "border-warning/25 bg-warning/10 text-warning",
    success: "border-success/25 bg-success/10 text-success",
    destructive: "border-destructive/25 bg-destructive/10 text-destructive",
    muted: "border-border bg-muted text-muted-foreground",
  };
  return (
    <span className={`fade-in-150 inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${styles[tone]}`}>
      {label}
    </span>
  );
}

// LLD §0.25 — invite status, derived from accountActivated/inviteExpiresAt.
function InviteStatus({ resource }: { resource: ResourceDetailResponse }) {
  if (resource.accountActivated) {
    return (
      <span className="fade-in-150 inline-flex items-center rounded-full border border-success/25 bg-success/10 px-2 py-0.5 text-[11px] font-semibold text-success">
        Account activated
      </span>
    );
  }
  if (!resource.inviteExpiresAt) {
    return <span className="text-[13px] text-muted-foreground">Not invited yet</span>;
  }
  const expired = new Date(resource.inviteExpiresAt) < new Date();
  return (
    <span
      className={`fade-in-150 inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
        expired ? "border-destructive/25 bg-destructive/10 text-destructive" : "border-warning/25 bg-warning/10 text-warning"
      }`}
    >
      {expired ? "Invite expired" : `Invite sent — expires ${formatActionDate(resource.inviteExpiresAt)}`}
    </span>
  );
}

function ResourceDetail() {
  const { id } = Route.useParams();
  const queryClient = useQueryClient();
  const detailQuery = useQuery({
    queryKey: ["admin", "resources", id],
    queryFn: () => api.get<ResourceDetailResponse>(`/admin/resources/${id}`),
  });
  const [confirming, setConfirming] = useState(false);

  const unlockBank = useMutation({
    mutationFn: () => api.post(`/admin/resources/${id}/unlock-bank`),
    onSuccess: () => {
      setConfirming(false);
      queryClient.invalidateQueries({ queryKey: ["admin", "resources", id] });
    },
  });

  const sendInvite = useMutation({
    mutationFn: () => api.post(`/admin/resources/${id}/send-invite`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin", "resources", id] }),
  });

  // LLD §0.29: recovery flow for a gate-2 decline — resets approvalStatus to
  // PENDING only (gate 1 and the document are untouched) and notifies the
  // resource.
  const reopenInvoice = useMutation({
    mutationFn: (invoiceId: string) => api.post(`/admin/invoices/${invoiceId}/reopen`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin", "resources", id] }),
  });

  // LLD §0.9/§0.24: recovery flow for a gate-1 amount rejection — re-reads the
  // amount from the (corrected + re-synced) SheetRow, resets the confirmation
  // gate to PENDING, and re-queues document generation.
  const reprocessInvoice = useMutation({
    mutationFn: (invoiceId: string) => api.post(`/admin/invoices/${invoiceId}/reprocess`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin", "resources", id] }),
  });

  if (detailQuery.isLoading) {
    return (
      <div className="min-h-screen bg-background">
        <AppSidebar active="Resources" />
        <main className="flex items-center gap-2 px-4 pt-20 pb-10 text-[13px] text-muted-foreground tab:ml-[220px] tab:px-8 tab:pt-10">
          <Loader2 className="size-4 animate-spin" />
          Loading resource…
        </main>
      </div>
    );
  }

  if (detailQuery.isError || !detailQuery.data) {
    return (
      <div className="min-h-screen bg-background">
        <AppSidebar active="Resources" />
        <main className="space-y-3 px-4 pt-20 pb-10 tab:ml-[220px] tab:px-8 tab:pt-10">
          <p className="text-[14px] text-muted-foreground">Resource not found.</p>
          <Link to="/resources" className="text-[13px] text-primary underline-offset-4 hover:underline">
            Back to resources
          </Link>
        </main>
      </div>
    );
  }

  const resource = detailQuery.data;
  // bankLocked = false means an admin has unlocked details and the resource
  // hasn't saved yet (LLD §2.5/§2.6 — no separate "unlocked" flag exists,
  // this is the same field PUT /resource/profile flips back to true on save).
  const mode: "locked" | "confirming" | "unlocked" = !resource.bankLocked
    ? "unlocked"
    : confirming
      ? "confirming"
      : "locked";

  return (
    <div className="min-h-screen bg-background">
      <AppSidebar active="Resources" />
      <main className="pt-14 tab:ml-[220px] tab:pt-0">
        <header className="flex h-14 items-center border-b border-border px-4 tab:px-8">
          <Link
            to="/resources"
            className="flex items-center gap-1.5 text-[13px] text-muted-foreground transition-colors duration-150 hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" />
            Resources
          </Link>
        </header>

        <div className="space-y-6 px-4 py-6 tab:px-8">
          <h1 className="text-[28px] leading-none font-medium tracking-tight">{resource.name}</h1>

          <div className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-card p-4 tab:p-6">
            <InviteStatus resource={resource} />
            {!resource.accountActivated && (
              <Button
                variant="outline"
                size="sm"
                disabled={sendInvite.isPending}
                className="h-11 text-[12px] tab:h-8"
                onClick={() => sendInvite.mutate()}
              >
                {sendInvite.isPending && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
                {resource.inviteExpiresAt ? "Resend invite" : "Send invite"}
              </Button>
            )}
          </div>

          <div>
            <div className="rounded-md border border-border bg-card p-4 tab:p-6">
              <div className="mb-5 flex flex-col gap-3 tab:flex-row tab:items-start tab:justify-between tab:gap-4">
                <div className="flex flex-wrap items-center gap-3">
                  <h2 className="text-[20px] leading-none font-medium tracking-tight text-foreground">
                    Profile details
                  </h2>
                  {mode === "unlocked" && (
                    <span className="fade-in-150 inline-flex items-center rounded-full border border-warning/25 bg-warning/10 px-2 py-0.5 text-[11px] font-semibold text-warning">
                      Unlocked — awaiting resource edit
                    </span>
                  )}
                </div>
                {mode === "locked" && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-11 w-full text-[12px] tab:h-8 tab:w-auto"
                    onClick={() => setConfirming(true)}
                  >
                    Unlock details
                  </Button>
                )}
              </div>

              {mode === "confirming" && (
                <div className="fade-in-150 mb-5 flex flex-wrap items-center gap-3 rounded-md border border-border bg-background px-4 py-3">
                  <p className="text-[13px] text-foreground">
                    This will let {resource.name} edit their locked details again until they save.
                    Continue?
                  </p>
                  <div className="flex gap-2 tab:ml-auto">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-11 w-full text-[12px] tab:h-8 tab:w-auto"
                      onClick={() => setConfirming(false)}
                    >
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      disabled={unlockBank.isPending}
                      className="h-11 w-full text-[12px] tab:h-8 tab:w-auto"
                      onClick={() => unlockBank.mutate()}
                    >
                      {unlockBank.isPending && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
                      Confirm
                    </Button>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-1 gap-x-10 gap-y-5 tab:grid-cols-2 md:grid-cols-4">
                <Field label="Email" value={resource.email} />
                <Field label="Contact number" value={resource.contactNo} />
                <Field label="PAN" value={resource.pan} />
                <Field label="Address" value={resource.address} />
              </div>
              <div className="my-6 h-px bg-border" />
              <div className="grid grid-cols-1 gap-x-10 gap-y-5 tab:grid-cols-2 md:grid-cols-4">
                <Field label="Beneficiary name" value={resource.beneficiaryName} />
                <Field label="Account number" value={resource.accountNo} />
                <Field label="Bank name" value={resource.bankName} />
                <Field label="IFSC code" value={resource.ifsc} />
              </div>
            </div>
          </div>

          <div>
            <h2 className="mb-3 text-[20px] leading-none font-medium tracking-tight">
              Invoice history
            </h2>
            {resource.invoices.length === 0 ? (
              <div className="fade-in-150 flex flex-col items-center justify-center rounded-md border border-border bg-card px-6 py-10 text-center">
                <p className="text-[13px] text-muted-foreground">No invoices yet for this resource</p>
              </div>
            ) : (
              <>
                <div className="hidden overflow-hidden rounded-md border border-border bg-card tab:block">
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[720px] border-collapse">
                      <thead>
                        <tr className="border-b border-border">
                          <th className={th + " sticky left-0 z-10 bg-card xl:static"}>Project name</th>
                          <th className={th}>Batch</th>
                          <th className={th + " text-right"}>Amount</th>
                          <th className={th}>Status</th>
                          <th className={th}>Action date</th>
                          <th className={th}>Reason</th>
                          <th className={th}></th>
                        </tr>
                      </thead>
                      <tbody>
                        {resource.invoices.map((inv) => (
                          <tr key={inv.id} className="h-12 border-b border-border last:border-0">
                            <td className={td + " sticky left-0 z-10 bg-card xl:static"}>
                              {inv.projectName}
                            </td>
                            <td className={td + " num"}>{inv.batch}</td>
                            <td className={td + " num text-right"}>{inr(inv.amount)}</td>
                            <td className={td}>
                              <InvoiceStatusBadge invoice={inv} />
                            </td>
                            <td className={td + " num text-muted-foreground"}>
                              {formatActionDate(inv.actionedAt)}
                            </td>
                            <td className={td + " text-muted-foreground"}>{invoiceReason(inv)}</td>
                            <td className={td}>
                              {inv.approvalStatus === "DECLINED" && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  disabled={reopenInvoice.isPending}
                                  className="h-8 gap-1.5 bg-card text-[12px]"
                                  onClick={() => reopenInvoice.mutate(inv.id)}
                                >
                                  {reopenInvoice.isPending && reopenInvoice.variables === inv.id && (
                                    <Loader2 className="size-3 animate-spin" />
                                  )}
                                  Reopen
                                </Button>
                              )}
                              {inv.amountConfirmationStatus === "REJECTED" && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  disabled={reprocessInvoice.isPending}
                                  title="Correct the amount in the Google Sheet and re-sync first, then reprocess to regenerate the invoice."
                                  className="h-8 gap-1.5 bg-card text-[12px]"
                                  onClick={() => reprocessInvoice.mutate(inv.id)}
                                >
                                  {reprocessInvoice.isPending && reprocessInvoice.variables === inv.id && (
                                    <Loader2 className="size-3 animate-spin" />
                                  )}
                                  Reprocess
                                </Button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Mobile: stacked cards */}
                <div className="flex flex-col gap-3 tab:hidden">
                  {resource.invoices.map((inv) => (
                    <MobileCard key={inv.id}>
                      <div className="flex items-start justify-between gap-3">
                        <div className="text-[14px] font-medium text-foreground">
                          {inv.projectName} — Batch <span className="num">{inv.batch}</span>
                        </div>
                        <div className="num text-[18px] leading-none font-medium text-foreground">
                          {inr(inv.amount)}
                        </div>
                      </div>
                      <MobileField label="Status">
                        <InvoiceStatusBadge invoice={inv} />
                      </MobileField>
                      <MobileField label="Action date">
                        <span className="num text-muted-foreground">
                          {formatActionDate(inv.actionedAt) || "—"}
                        </span>
                      </MobileField>
                      <MobileField label="Reason">
                        <span className="text-muted-foreground">{invoiceReason(inv) || "—"}</span>
                      </MobileField>
                      {inv.approvalStatus === "DECLINED" && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={reopenInvoice.isPending}
                          className="h-11 w-full gap-1.5 bg-card text-[12px]"
                          onClick={() => reopenInvoice.mutate(inv.id)}
                        >
                          {reopenInvoice.isPending && reopenInvoice.variables === inv.id && (
                            <Loader2 className="size-3.5 animate-spin" />
                          )}
                          Reopen
                        </Button>
                      )}
                      {inv.amountConfirmationStatus === "REJECTED" && (
                        <>
                          <p className="text-[11px] text-muted-foreground">
                            Fix the amount in the Google Sheet and re-sync, then reprocess.
                          </p>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={reprocessInvoice.isPending}
                            className="h-11 w-full gap-1.5 bg-card text-[12px]"
                            onClick={() => reprocessInvoice.mutate(inv.id)}
                          >
                            {reprocessInvoice.isPending && reprocessInvoice.variables === inv.id && (
                              <Loader2 className="size-3.5 animate-spin" />
                            )}
                            Reprocess
                          </Button>
                        </>
                      )}
                    </MobileCard>
                  ))}
                </div>
              </>
            )}
          </div>

          <DocumentsSection resourceId={resource.id} documents={resource.documents} />
        </div>
      </main>
    </div>
  );
}

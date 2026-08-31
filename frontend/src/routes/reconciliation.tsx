import { useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import { Loader2, Upload, CheckCircle2 } from "lucide-react";

import { AppSidebar } from "@/components/ops/AppSidebar";
import { MobileCard, MobileField } from "@/components/ops/MobileRow";
import { Button } from "@/components/ui/button";
import { api, ApiError } from "@/lib/api";
import { inr } from "@/data/rows";

export const Route = createFileRoute("/reconciliation")({
  head: () => ({
    meta: [
      { title: "Reconciliation — Payouts Console" },
      {
        name: "description",
        content: "Upload a bank payout file and cross-check it against approved, generated invoices.",
      },
      { property: "og:title", content: "Reconciliation — Payouts Console" },
      {
        property: "og:description",
        content: "Match bank transactions against approved invoices and find unpaid ones.",
      },
    ],
  }),
  component: ReconciliationPage,
});

// LLD §0.26 / §2.3: POST /admin/reconciliation
type Matched = { invoiceId: string; invoiceNo: string; resourceId: string; resourceName: string; amount: number; creditAccountNo: string };
type Ambiguous = {
  resourceId: string;
  resourceName: string;
  amount: number;
  creditAccountNo: string;
  candidates: { invoiceId: string; invoiceNo: string }[];
};
type NotPaid = { invoiceId: string; invoiceNo: string; resourceId: string; resourceName: string; amount: number };
type UnrecognizedRow = { srNo: string; creditAccountNo: string; creditAccountName: string; ifsc: string; amount: number; reason: string };

type ReconciliationResult = {
  matched: Matched[];
  ambiguous: Ambiguous[];
  notPaid: NotPaid[];
  unrecognizedRows: UnrecognizedRow[];
};

const th = "px-3 py-2 text-left text-[12px] font-medium text-muted-foreground";
const td = "px-3 text-[13px] text-foreground";

function SectionCard({
  title,
  count,
  tone,
  description,
  children,
}: {
  title: string;
  count: number;
  tone: "success" | "warning" | "destructive" | "muted";
  description: string;
  children: React.ReactNode;
}) {
  const toneStyles = {
    success: "border-success/25 bg-success/10 text-success",
    warning: "border-warning/25 bg-warning/10 text-warning",
    destructive: "border-destructive/25 bg-destructive/10 text-destructive",
    muted: "border-border bg-muted text-muted-foreground",
  };
  return (
    <div className="fade-in-150 overflow-hidden rounded-md border border-border bg-card">
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
        <h2 className="text-[14px] font-medium text-foreground">{title}</h2>
        <span className={`inline-flex min-w-6 items-center justify-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${toneStyles[tone]}`}>
          {count}
        </span>
        <span className="text-[12px] text-muted-foreground">{description}</span>
      </div>
      {count === 0 ? (
        <p className="px-4 py-6 text-center text-[13px] text-muted-foreground">None</p>
      ) : (
        children
      )}
    </div>
  );
}

function ReconciliationPage() {
  const pickerRef = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<ReconciliationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resolved, setResolved] = useState<Set<string>>(new Set()); // invoiceIds marked paid from an ambiguous group this session

  const upload = useMutation({
    mutationFn: (file: File) => api.upload<ReconciliationResult>("/admin/reconciliation", file),
    onSuccess: (data) => {
      setResult(data);
      setError(null);
      setResolved(new Set());
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    },
  });

  const markPaid = useMutation({
    mutationFn: (invoiceId: string) => api.post<{ invoiceId: string; paidAt: string }>(`/admin/invoices/${invoiceId}/mark-paid`),
    onSuccess: (_data, invoiceId) => {
      setResolved((prev) => new Set(prev).add(invoiceId));
    },
  });

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) upload.mutate(file);
    e.target.value = "";
  };

  // A whole ambiguous group is "settled" once one of its candidates has been marked paid.
  const openAmbiguous = (result?.ambiguous ?? []).filter(
    (group) => !group.candidates.some((c) => resolved.has(c.invoiceId))
  );

  return (
    <div className="min-h-screen bg-background">
      <AppSidebar active="Reconciliation" />
      <main className="pt-14 tab:ml-[220px] tab:pt-0">
        <header className="flex flex-col gap-3 border-b border-border px-4 py-4 tab:h-14 tab:flex-row tab:items-center tab:justify-between tab:gap-3 tab:px-8 tab:py-0">
          <h1 className="text-[28px] leading-none font-medium tracking-tight">Reconciliation</h1>
          <div>
            <input ref={pickerRef} type="file" accept=".csv,text/csv" className="hidden" onChange={onPick} />
            <Button
              size="sm"
              onClick={() => pickerRef.current?.click()}
              disabled={upload.isPending}
              className="h-11 gap-2 text-[13px] font-medium tab:h-8"
            >
              {upload.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
              {upload.isPending ? "Uploading…" : "Upload bank file"}
            </Button>
          </div>
        </header>

        <div className="px-4 py-6 tab:px-8">
          {error && (
            <div className="fade-in-150 mb-4 rounded-md border border-destructive/25 bg-destructive/10 px-4 py-3 text-[13px] text-destructive">
              {error}
            </div>
          )}

          {!result ? (
            <div className="fade-in-150 flex max-w-3xl flex-col items-center justify-center rounded-md border border-border bg-card px-6 py-16 text-center tab:px-8">
              <p className="text-[14px] font-medium text-foreground">No reconciliation run yet</p>
              <p className="mt-1 text-[13px] text-muted-foreground">
                Upload a bank CSV (NEFT transactions — account no., IFSC, amount) to match it against
                approved, generated invoices.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <SectionCard
                title="Matched"
                count={result.matched.length}
                tone="success"
                description="marked paid"
              >
                <>
                  <div className="hidden overflow-x-auto tab:block">
                    <table className="w-full min-w-[640px] border-collapse">
                      <thead>
                        <tr className="border-b border-border">
                          <th className={th}>Invoice</th>
                          <th className={th}>Resource</th>
                          <th className={th + " text-right"}>Amount</th>
                          <th className={th}>Account No.</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.matched.map((m) => (
                          <tr key={m.invoiceId} className="h-11 border-b border-border last:border-0">
                            <td className={td + " num"}>{m.invoiceNo}</td>
                            <td className={td}>{m.resourceName}</td>
                            <td className={td + " num text-right"}>{inr(m.amount)}</td>
                            <td className={td + " num text-muted-foreground"}>{m.creditAccountNo}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="flex flex-col gap-3 p-3 tab:hidden">
                    {result.matched.map((m) => (
                      <MobileCard key={m.invoiceId}>
                        <div className="text-[14px] font-medium text-foreground">{m.invoiceNo}</div>
                        <MobileField label="Resource">{m.resourceName}</MobileField>
                        <MobileField label="Amount"><span className="num">{inr(m.amount)}</span></MobileField>
                        <MobileField label="Account No."><span className="num text-muted-foreground">{m.creditAccountNo}</span></MobileField>
                      </MobileCard>
                    ))}
                  </div>
                </>
              </SectionCard>

              <SectionCard
                title="Ambiguous"
                count={openAmbiguous.length}
                tone="warning"
                description="same resource + amount matched more than one invoice — pick which one got paid"
              >
                <ul className="flex flex-col gap-2 p-3">
                  {openAmbiguous.map((group, i) => (
                    <li key={i} className="rounded-md border border-warning/20 bg-warning/5 p-3">
                      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                        <span className="text-[13px] text-foreground">
                          {group.resourceName} — <span className="num">{inr(group.amount)}</span>
                        </span>
                        <span className="num text-[12px] text-muted-foreground">Acct {group.creditAccountNo}</span>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {group.candidates.map((c) => (
                          <Button
                            key={c.invoiceId}
                            size="sm"
                            variant="outline"
                            disabled={markPaid.isPending}
                            className="h-8 gap-1.5 bg-card text-[12px]"
                            onClick={() => markPaid.mutate(c.invoiceId)}
                          >
                            {markPaid.isPending && markPaid.variables === c.invoiceId && (
                              <Loader2 className="size-3 animate-spin" />
                            )}
                            Mark {c.invoiceNo} paid
                          </Button>
                        ))}
                      </div>
                    </li>
                  ))}
                </ul>
              </SectionCard>

              <SectionCard
                title="Not paid"
                count={result.notPaid.length}
                tone="destructive"
                description="approved & generated, not found in this file — admin notified"
              >
                <>
                  <div className="hidden overflow-x-auto tab:block">
                    <table className="w-full min-w-[560px] border-collapse">
                      <thead>
                        <tr className="border-b border-border">
                          <th className={th}>Invoice</th>
                          <th className={th}>Resource</th>
                          <th className={th + " text-right"}>Amount</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.notPaid.map((n) => (
                          <tr key={n.invoiceId} className="h-11 border-b border-border last:border-0">
                            <td className={td + " num"}>{n.invoiceNo}</td>
                            <td className={td}>{n.resourceName}</td>
                            <td className={td + " num text-right"}>{inr(n.amount)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="flex flex-col gap-3 p-3 tab:hidden">
                    {result.notPaid.map((n) => (
                      <MobileCard key={n.invoiceId}>
                        <div className="text-[14px] font-medium text-foreground">{n.invoiceNo}</div>
                        <MobileField label="Resource">{n.resourceName}</MobileField>
                        <MobileField label="Amount"><span className="num">{inr(n.amount)}</span></MobileField>
                      </MobileCard>
                    ))}
                  </div>
                </>
              </SectionCard>

              <SectionCard
                title="Unrecognized rows"
                count={result.unrecognizedRows.length}
                tone="muted"
                description="rows in the file that didn't match anything"
              >
                <>
                  <div className="hidden overflow-x-auto tab:block">
                    <table className="w-full min-w-[720px] border-collapse">
                      <thead>
                        <tr className="border-b border-border">
                          <th className={th}>Sr. No</th>
                          <th className={th}>Account No.</th>
                          <th className={th}>Account Name</th>
                          <th className={th}>IFSC</th>
                          <th className={th + " text-right"}>Amount</th>
                          <th className={th}>Reason</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.unrecognizedRows.map((r, i) => (
                          <tr key={i} className="h-11 border-b border-border last:border-0">
                            <td className={td + " num text-muted-foreground"}>{r.srNo}</td>
                            <td className={td + " num"}>{r.creditAccountNo}</td>
                            <td className={td}>{r.creditAccountName}</td>
                            <td className={td + " num text-muted-foreground"}>{r.ifsc}</td>
                            <td className={td + " num text-right"}>{inr(r.amount)}</td>
                            <td className={td + " text-muted-foreground"}>{r.reason}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="flex flex-col gap-3 p-3 tab:hidden">
                    {result.unrecognizedRows.map((r, i) => (
                      <MobileCard key={i}>
                        <div className="text-[14px] font-medium text-foreground">{r.creditAccountName || "—"}</div>
                        <MobileField label="Account No."><span className="num">{r.creditAccountNo}</span></MobileField>
                        <MobileField label="IFSC"><span className="num text-muted-foreground">{r.ifsc}</span></MobileField>
                        <MobileField label="Amount"><span className="num">{inr(r.amount)}</span></MobileField>
                        <MobileField label="Reason"><span className="text-muted-foreground">{r.reason}</span></MobileField>
                      </MobileCard>
                    ))}
                  </div>
                </>
              </SectionCard>

              {markPaid.isSuccess && (
                <div className="fade-in-150 flex items-center gap-2 text-[12px] text-success">
                  <CheckCircle2 className="size-3.5" />
                  Marked paid.
                </div>
              )}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

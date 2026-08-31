import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, RefreshCw } from "lucide-react";
import { AppSidebar } from "@/components/ops/AppSidebar";
import { MobileCard, MobileField } from "@/components/ops/MobileRow";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { inr } from "@/data/rows";
import { api } from "@/lib/api";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Admin Dashboard — Payouts Console" },
      {
        name: "description",
        content:
          "Review synced freelance payout rows, generate invoices by row range, and track approval status.",
      },
      { property: "og:title", content: "Admin Dashboard — Payouts Console" },
      {
        property: "og:description",
        content: "Review synced payout rows and generate invoices for freelance resources.",
      },
    ],
  }),
  component: Dashboard,
});

// LLD §2.3 / §0.20: GET /admin/sheet-rows
type SheetRow = {
  id: string;
  resourceName: string;
  resourceEmail: string;
  projectName: string;
  batch: string;
  role: string;
  hours: number;
  rate: number;
  computedAmount: number;
  invoiceId: string | null;
  generationStatus: "FLAGGED" | "QUEUED" | "PROCESSING" | "GENERATED" | "FAILED" | null;
};

// LLD §2.2: POST /admin/sync
type SyncResult = {
  syncedAt: string;
  rowsProcessed: number;
  newResourcesCreated: number;
  rowsUpdated: number;
  rowsUnchanged: number;
  skipped: { rowRef: string; reason: string }[];
};

// LLD §2.3: POST /admin/invoices/generate
type GenerateResult = {
  batchId: string;
  clean: { sheetRowId: string; invoiceId: string }[];
  flagged: { sheetRowId: string; invoiceId: string; flagReason: string }[];
};

// LLD §2.3: GET /admin/invoices/status/:batchId
type BatchStatus = {
  batchId: string;
  total: number;
  counts: { queued: number; processing: number; generated: number; failed: number; flagged: number };
};

const th = "px-3 py-2 text-left text-[12px] font-medium text-muted-foreground";
const td = "px-3 text-[13px] text-foreground";

const GENERATION_LABEL: Record<NonNullable<SheetRow["generationStatus"]>, string> = {
  QUEUED: "Queued",
  PROCESSING: "Processing",
  GENERATED: "Generated",
  FAILED: "Failed",
  FLAGGED: "Flagged",
};

const GENERATION_TONE: Record<NonNullable<SheetRow["generationStatus"]>, "warning" | "success" | "destructive" | "muted"> = {
  QUEUED: "muted",
  PROCESSING: "warning",
  GENERATED: "success",
  FAILED: "destructive",
  FLAGGED: "destructive",
};

// This screen only shows generationStatus (GET /admin/sheet-rows doesn't
// carry the two-gate amountConfirmationStatus/approvalStatus — those belong
// to the Resources/invoices views). "Not Generated" here means the row has
// no Invoice yet at all.
function GenerationBadge({ status }: { status: SheetRow["generationStatus"] }) {
  if (!status) {
    return (
      <span className="fade-in-150 inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">
        Not Generated
      </span>
    );
  }
  const tone = GENERATION_TONE[status];
  const styles = {
    warning: "border-warning/25 bg-warning/10 text-warning",
    success: "border-success/25 bg-success/10 text-success",
    destructive: "border-destructive/25 bg-destructive/10 text-destructive",
    muted: "border-border bg-muted text-muted-foreground",
  };
  return (
    <span className={`fade-in-150 inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${styles[tone]}`}>
      {GENERATION_LABEL[status]}
    </span>
  );
}

function formatSyncedAt(iso: string) {
  return new Date(iso).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function Dashboard() {
  const queryClient = useQueryClient();
  const rowsQuery = useQuery({
    queryKey: ["admin", "sheet-rows"],
    queryFn: () => api.get<SheetRow[]>("/admin/sheet-rows"),
  });
  const rows = useMemo(() => rowsQuery.data ?? [], [rowsQuery.data]);

  const [selected, setSelected] = useState<string[]>([]);
  const [startRow, setStartRow] = useState("");
  const [endRow, setEndRow] = useState("");
  const [lastSynced, setLastSynced] = useState<string | null>(null);
  const [syncSummary, setSyncSummary] = useState<SyncResult | null>(null);
  const [flagged, setFlagged] = useState<GenerateResult["flagged"]>([]);
  const [pollingBatchId, setPollingBatchId] = useState<string | null>(null);

  const invalidateRows = () => queryClient.invalidateQueries({ queryKey: ["admin", "sheet-rows"] });

  const sync = useMutation({
    mutationFn: () => api.post<SyncResult>("/admin/sync"),
    onSuccess: (result) => {
      setLastSynced(result.syncedAt);
      setSyncSummary(result);
      invalidateRows();
    },
  });

  const generate = useMutation({
    mutationFn: (sheetRowIds: string[]) => api.post<GenerateResult>("/admin/invoices/generate", { sheetRowIds }),
    onSuccess: (result) => {
      setSelected([]);
      setFlagged(result.flagged);
      if (result.clean.length > 0) setPollingBatchId(result.batchId);
      invalidateRows();
    },
  });

  const acknowledgeFlag = useMutation({
    mutationFn: (invoiceId: string) => api.post(`/admin/invoices/${invoiceId}/acknowledge-flag`),
    onSuccess: (_data, invoiceId) => {
      setFlagged((prev) => prev.filter((f) => f.invoiceId !== invoiceId));
      invalidateRows();
    },
  });

  // Polls the generation batch (LLD §2.3) until every row has left QUEUED/
  // PROCESSING, refreshing the row list as it goes so status changes show up
  // without a manual refresh.
  useEffect(() => {
    if (!pollingBatchId) return;
    const interval = setInterval(async () => {
      const status = await api.get<BatchStatus>(`/admin/invoices/status/${pollingBatchId}`);
      invalidateRows();
      if (status.counts.queued === 0 && status.counts.processing === 0) {
        setPollingBatchId(null);
      }
    }, 2000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pollingBatchId]);

  const allSelected = selected.length === rows.length && rows.length > 0;
  const total = useMemo(() => rows.reduce((s, r) => s + r.computedAmount, 0), [rows]);

  const toggleRow = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const runGenerate = () => {
    if (generate.isPending) return;
    const targets = selected.length
      ? selected
      : rows
          .filter((_, i) => i + 1 >= Number(startRow || 0) && i + 1 <= Number(endRow || 0))
          .map((r) => r.id);
    if (!targets.length) return;
    generate.mutate(targets);
  };

  return (
    <div className="min-h-screen bg-background">
      <AppSidebar active="Dashboard" />
      <main className="pt-14 tab:ml-[220px] tab:pt-0">
        <header className="flex flex-col gap-3 border-b border-border px-4 py-4 tab:px-8 lg:h-14 lg:flex-row lg:items-center lg:justify-between lg:gap-3 lg:py-0">
          <h1 className="text-[28px] leading-none font-medium tracking-tight">Dashboard</h1>
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-[13px] text-muted-foreground">
              Last synced <span className="num">{lastSynced ? formatSyncedAt(lastSynced) : "never"}</span>
            </span>
            <Button
              size="sm"
              onClick={() => sync.mutate()}
              disabled={sync.isPending}
              className="h-11 gap-2 text-[13px] font-medium tab:h-8"
            >
              {sync.isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
              {sync.isPending ? "Syncing…" : "Sync from Google Sheets"}
            </Button>
          </div>
        </header>

        <div className="px-4 py-6 tab:px-8">
          {syncSummary && (
            <div className="fade-in-150 mb-4 rounded-md border border-border bg-card px-4 py-3 text-[12px] text-muted-foreground">
              Synced: {syncSummary.rowsProcessed} processed, {syncSummary.newResourcesCreated} new
              resources, {syncSummary.rowsUpdated} updated, {syncSummary.rowsUnchanged} unchanged
              {syncSummary.skipped.length > 0 && `, ${syncSummary.skipped.length} skipped`}.
              {syncSummary.skipped.length > 0 && (
                <ul className="mt-1.5 list-inside list-disc">
                  {syncSummary.skipped.map((s, i) => (
                    <li key={i}>{s.rowRef}: {s.reason}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {flagged.length > 0 && (
            <div className="fade-in-150 mb-4 rounded-md border border-destructive/25 bg-destructive/10 px-4 py-3 text-[12px] text-destructive">
              <p className="font-medium">{flagged.length} row(s) held — needs your review before generating:</p>
              <ul className="mt-2 flex flex-col gap-2">
                {flagged.map((f) => (
                  <li key={f.invoiceId} className="flex flex-wrap items-center justify-between gap-2">
                    <span>{f.flagReason}</span>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={acknowledgeFlag.isPending}
                      className="h-8 border-destructive/30 text-destructive hover:bg-destructive/10"
                      onClick={() => acknowledgeFlag.mutate(f.invoiceId)}
                    >
                      Acknowledge & queue
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="mb-4 flex flex-col gap-4 lg:flex-row lg:flex-wrap lg:items-end lg:justify-between">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
              <div>
                <label className="mb-1 block text-[12px] text-muted-foreground">Start row</label>
                <Input
                  value={startRow}
                  onChange={(e) => setStartRow(e.target.value)}
                  inputMode="numeric"
                  placeholder="1"
                  className="num h-11 w-full bg-card text-[13px] lg:h-8 lg:w-24"
                />
              </div>
              <div>
                <label className="mb-1 block text-[12px] text-muted-foreground">End row</label>
                <Input
                  value={endRow}
                  onChange={(e) => setEndRow(e.target.value)}
                  inputMode="numeric"
                  placeholder="14"
                  className="num h-11 w-full bg-card text-[13px] lg:h-8 lg:w-24"
                />
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={runGenerate}
                disabled={generate.isPending}
                className="h-11 w-full gap-2 bg-card text-[13px] font-medium lg:h-8 lg:w-auto"
              >
                {generate.isPending && <Loader2 className="size-3.5 animate-spin" />}
                {generate.isPending ? "Generating…" : "Generate invoices"}
              </Button>
              <span className="text-[12px] text-muted-foreground lg:pb-2">
                {selected.length
                  ? `${selected.length} row(s) selected — range ignored`
                  : "Or select rows with checkboxes"}
              </span>
            </div>
            <div className="text-[13px] text-muted-foreground lg:pb-1">
              Total payable <span className="num text-foreground">{inr(total)}</span>
            </div>
          </div>

          {rowsQuery.isLoading ? (
            <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Loading synced rows…
            </div>
          ) : rowsQuery.isError ? (
            <div className="flex max-w-3xl flex-col items-start gap-3 rounded-md border border-destructive/25 bg-destructive/10 px-6 py-8 text-[13px] text-destructive">
              <p>Couldn't load synced rows. Please try again.</p>
              <Button size="sm" variant="outline" onClick={() => rowsQuery.refetch()}>
                Retry
              </Button>
            </div>
          ) : rows.length === 0 ? (
            <div className="fade-in-150 flex max-w-3xl flex-col items-center justify-center rounded-md border border-border bg-card px-6 py-16 text-center tab:px-8">
              <p className="text-[14px] font-medium text-foreground">No rows yet</p>
              <p className="mt-1 text-[13px] text-muted-foreground">
                Rows will appear here after your first sync
              </p>
            </div>
          ) : (
            <>
              {/* Tablet & desktop: table with sticky name column on horizontal scroll */}
              <div className="hidden overflow-hidden rounded-md border border-border bg-card tab:block">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[900px] border-collapse">
                    <thead>
                      <tr className="border-b border-border">
                        <th className={th + " w-10"}>
                          <Checkbox
                            checked={allSelected}
                            onCheckedChange={(v) => setSelected(v ? rows.map((r) => r.id) : [])}
                            aria-label="Select all rows"
                          />
                        </th>
                        <th className={th + " w-14"}>Row #</th>
                        <th className={th + " sticky left-0 z-10 bg-card xl:static"}>Name</th>
                        <th className={th}>Email</th>
                        <th className={th}>Project Name</th>
                        <th className={th}>Batch</th>
                        <th className={th}>Role</th>
                        <th className={th + " text-right"}>Hours</th>
                        <th className={th + " text-right"}>Rate</th>
                        <th className={th + " text-right"}>Amount</th>
                        <th className={th}>Invoice Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r, i) => (
                        <tr
                          key={r.id}
                          className="group h-12 border-b border-border transition-colors duration-150 last:border-0 hover:bg-muted/50"
                        >
                          <td className={td}>
                            <Checkbox
                              checked={selected.includes(r.id)}
                              onCheckedChange={() => toggleRow(r.id)}
                              aria-label={`Select row ${i + 1}`}
                            />
                          </td>
                          <td className={td + " num text-muted-foreground"}>{i + 1}</td>
                          <td
                            className={
                              td + " sticky left-0 z-10 bg-card group-hover:bg-muted/50 xl:static"
                            }
                          >
                            {r.resourceName}
                          </td>
                          <td className={td + " text-muted-foreground"}>{r.resourceEmail}</td>
                          <td className={td}>{r.projectName}</td>
                          <td className={td + " num"}>{r.batch}</td>
                          <td className={td + " text-muted-foreground"}>{r.role}</td>
                          <td className={td + " num text-right"}>{r.hours}</td>
                          <td className={td + " num text-right"}>{inr(r.rate)}</td>
                          <td className={td + " num text-right"}>{inr(r.computedAmount)}</td>
                          <td className={td}>
                            <GenerationBadge status={r.generationStatus} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Mobile: stacked cards */}
              <div className="flex flex-col gap-3 tab:hidden">
                {rows.map((r, i) => (
                  <MobileCard key={r.id}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-start gap-2">
                        <Checkbox
                          checked={selected.includes(r.id)}
                          onCheckedChange={() => toggleRow(r.id)}
                          aria-label={`Select row ${i + 1}`}
                          className="mt-0.5"
                        />
                        <div>
                          <div className="text-[14px] font-medium text-foreground">{r.resourceName}</div>
                          <div className="text-[12px] text-muted-foreground">
                            Row <span className="num">{i + 1}</span>
                          </div>
                        </div>
                      </div>
                      <GenerationBadge status={r.generationStatus} />
                    </div>
                    <MobileField label="Email">
                      <span className="text-muted-foreground">{r.resourceEmail}</span>
                    </MobileField>
                    <MobileField label="Project">{r.projectName}</MobileField>
                    <MobileField label="Batch">
                      <span className="num">{r.batch}</span>
                    </MobileField>
                    <MobileField label="Role">
                      <span className="text-muted-foreground">{r.role}</span>
                    </MobileField>
                    <MobileField label="Hours">
                      <span className="num">{r.hours}</span>
                    </MobileField>
                    <MobileField label="Rate">
                      <span className="num">{inr(r.rate)}</span>
                    </MobileField>
                    <MobileField label="Amount">
                      <span className="num">{inr(r.computedAmount)}</span>
                    </MobileField>
                  </MobileCard>
                ))}
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}

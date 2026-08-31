import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { AppSidebar } from "@/components/ops/AppSidebar";
import { MobileField } from "@/components/ops/MobileRow";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";

export const Route = createFileRoute("/resources/")({
  head: () => ({
    meta: [
      { title: "Resources — Payouts Console" },
      {
        name: "description",
        content:
          "Directory of freelance resources with invoice counts by pending, approved and declined status.",
      },
      { property: "og:title", content: "Resources — Payouts Console" },
      {
        property: "og:description",
        content: "Freelance resource directory with invoice status counts.",
      },
    ],
  }),
  component: ResourcesPage,
});

// LLD §2.5: GET /admin/resources
type ResourceSummary = {
  id: string;
  name: string;
  email: string;
  totalInvoices: number;
  pending: number;
  approved: number;
  declined: number;
  pendingDocuments: boolean;
};

const th = "px-3 py-2 text-left text-[12px] font-medium text-muted-foreground";
const td = "px-3 text-[13px] text-foreground";

const counts = {
  pending: "border-warning/25 bg-warning/10 text-warning",
  approved: "border-success/25 bg-success/10 text-success",
  declined: "border-destructive/25 bg-destructive/10 text-destructive",
};

function Count({ n, tone }: { n: number; tone: keyof typeof counts }) {
  if (!n) return <span className="num text-[13px] text-muted-foreground/60">0</span>;
  return (
    <span
      className={
        "num inline-flex min-w-6 items-center justify-center rounded-full border px-2 py-0.5 text-[11px] font-semibold " +
        counts[tone]
      }
    >
      {n}
    </span>
  );
}

function ResourcesPage() {
  const navigate = useNavigate();
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["admin", "resources"],
    queryFn: () => api.get<ResourceSummary[]>("/admin/resources"),
  });
  const list = data ?? [];

  return (
    <div className="min-h-screen bg-background">
      <AppSidebar active="Resources" />
      <main className="pt-14 tab:ml-[220px] tab:pt-0">
        <header className="flex flex-col gap-2 border-b border-border px-4 py-4 tab:h-14 tab:flex-row tab:items-center tab:justify-between tab:gap-3 tab:px-8 tab:py-0 tab:min-h-14">
          <h1 className="text-[28px] leading-none font-medium tracking-tight">Resources</h1>
        </header>
        <div className="px-4 py-6 tab:px-8">
          {isLoading ? (
            <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Loading resources…
            </div>
          ) : isError ? (
            <div className="flex max-w-3xl flex-col items-start gap-3 rounded-md border border-destructive/25 bg-destructive/10 px-6 py-8 text-[13px] text-destructive">
              <p>Couldn't load resources. Please try again.</p>
              <Button size="sm" variant="outline" onClick={() => refetch()}>
                Retry
              </Button>
            </div>
          ) : list.length === 0 ? (
            <div className="fade-in-150 flex flex-col items-center justify-center rounded-md border border-border bg-card px-6 py-16 text-center tab:px-8">
              <p className="text-[14px] font-medium text-foreground">No resources yet</p>
              <p className="mt-1 text-[13px] text-muted-foreground">
                Resources will appear here after your first sync
              </p>
            </div>
          ) : (
            <>
              <div className="hidden overflow-hidden rounded-md border border-border bg-card tab:block">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[720px] border-collapse">
                    <thead>
                      <tr className="border-b border-border">
                        <th className={th + " sticky left-0 z-10 bg-card xl:static"}>Name</th>
                        <th className={th}>Email</th>
                        <th className={th + " text-right"}>Total invoices</th>
                        <th className={th + " text-right"}>Pending</th>
                        <th className={th + " text-right"}>Approved</th>
                        <th className={th + " text-right"}>Declined</th>
                      </tr>
                    </thead>
                    <tbody>
                      {list.map((r) => (
                        <tr
                          key={r.id}
                          tabIndex={0}
                          role="link"
                          onClick={() => navigate({ to: "/resources/$id", params: { id: r.id } })}
                          onKeyDown={(e) => {
                            if (e.key === "Enter")
                              navigate({ to: "/resources/$id", params: { id: r.id } });
                          }}
                          className="group h-12 cursor-pointer border-b border-border transition-colors duration-150 outline-none last:border-0 hover:bg-muted/50 focus-visible:bg-muted/50"
                        >
                          <td
                            className={
                              td + " sticky left-0 z-10 bg-card group-hover:bg-muted/50 xl:static"
                            }
                          >
                            <span className="inline-flex items-center gap-2">
                              {r.name}
                              {r.pendingDocuments && (
                                <span className="fade-in-150 inline-flex items-center rounded-full border border-warning/25 bg-warning/10 px-1.5 py-[1px] text-[10px] font-semibold text-warning">
                                  Docs pending
                                </span>
                              )}
                            </span>
                          </td>
                          <td className={td + " text-muted-foreground"}>{r.email}</td>
                          <td className={td + " num text-right"}>{r.totalInvoices}</td>
                          <td className={td + " text-right"}>
                            <Count n={r.pending} tone="pending" />
                          </td>
                          <td className={td + " text-right"}>
                            <Count n={r.approved} tone="approved" />
                          </td>
                          <td className={td + " text-right"}>
                            <Count n={r.declined} tone="declined" />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Mobile: stacked cards */}
              <div className="flex flex-col gap-3 tab:hidden">
                {list.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => navigate({ to: "/resources/$id", params: { id: r.id } })}
                    className="w-full rounded-md border border-border bg-card p-4 text-left"
                  >
                    <div className="flex flex-col gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[14px] font-medium text-foreground">{r.name}</span>
                        {r.pendingDocuments && (
                          <span className="inline-flex items-center rounded-full border border-warning/25 bg-warning/10 px-1.5 py-[1px] text-[10px] font-semibold text-warning">
                            Docs pending
                          </span>
                        )}
                      </div>
                      <MobileField label="Email">
                        <span className="break-all text-muted-foreground">{r.email}</span>
                      </MobileField>
                      <MobileField label="Total invoices">
                        <span className="num">{r.totalInvoices}</span>
                      </MobileField>
                      <MobileField label="Pending">
                        <Count n={r.pending} tone="pending" />
                      </MobileField>
                      <MobileField label="Approved">
                        <Count n={r.approved} tone="approved" />
                      </MobileField>
                      <MobileField label="Declined">
                        <Count n={r.declined} tone="declined" />
                      </MobileField>
                    </div>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}

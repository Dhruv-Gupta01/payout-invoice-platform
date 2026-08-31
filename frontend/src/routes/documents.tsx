import { useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

import { ResourceSidebar } from "@/components/ops/ResourceSidebar";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";

export const Route = createFileRoute("/documents")({
  head: () => ({
    meta: [
      { title: "My Documents — Payouts Console" },
      {
        name: "description",
        content: "Track the verification status of your onboarding documents and re-upload rejected files.",
      },
      { property: "og:title", content: "My Documents — Payouts Console" },
      {
        property: "og:description",
        content: "Verification status for your Aadhaar, PAN, photo, passbook and NDA.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: DocumentsPage,
});

// LLD §2.7: Document.docType enum. The URL param the upload endpoint takes
// (aadhaar|pan|photo|bank_proof|nda) is the lowercase form of these.
type DocType = "AADHAAR" | "PAN" | "PHOTO" | "BANK_PROOF" | "NDA";
type DocStatus = "PENDING_REVIEW" | "VERIFIED" | "REJECTED";

type DocumentItem = {
  id: string;
  docType: DocType;
  fileUrl: string;
  status: DocStatus;
  rejectionReason: string | null;
  reviewedAt: string | null;
  uploadedAt: string;
};

const DOC_CATALOG: { type: DocType; param: string; label: string }[] = [
  { type: "AADHAAR", param: "aadhaar", label: "Aadhaar card" },
  { type: "PAN", param: "pan", label: "PAN card" },
  { type: "PHOTO", param: "photo", label: "Passport-size photo" },
  { type: "BANK_PROOF", param: "bank_proof", label: "Bank passbook / cancelled cheque" },
  { type: "NDA", param: "nda", label: "Signed NDA" },
];

const badgeStyles: Record<DocStatus, string> = {
  VERIFIED: "border-success/25 bg-success/10 text-success",
  PENDING_REVIEW: "border-warning/25 bg-warning/10 text-warning",
  REJECTED: "border-destructive/25 bg-destructive/10 text-destructive",
};

const badgeLabel: Record<DocStatus, string> = {
  VERIFIED: "Verified",
  PENDING_REVIEW: "Pending review",
  REJECTED: "Rejected",
};

function DocBadge({ status }: { status: DocStatus }) {
  return (
    <span
      className={`fade-in-150 inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${badgeStyles[status]}`}
    >
      {badgeLabel[status]}
    </span>
  );
}

function formatDate(iso: string) {
  const d = new Date(iso);
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

function DocumentsPage() {
  const queryClient = useQueryClient();
  const docsQuery = useQuery({
    queryKey: ["resource", "documents"],
    queryFn: () => api.get<DocumentItem[]>("/resource/documents"),
  });
  const pickerRef = useRef<HTMLInputElement>(null);
  const [targetParam, setTargetParam] = useState<string | null>(null);

  const upload = useMutation({
    mutationFn: ({ param, file }: { param: string; file: File }) =>
      api.upload<DocumentItem>(`/resource/documents/${param}`, file),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["resource", "documents"] }),
  });

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && targetParam) {
      upload.mutate({ param: targetParam, file });
    }
    e.target.value = "";
    setTargetParam(null);
  };

  return (
    <div className="min-h-screen bg-background">
      <ResourceSidebar active="Documents" />
      <main className="pt-14 pb-16 tab:ml-[220px] tab:pt-0 tab:pb-0">
        <header className="flex h-14 items-center border-b border-border px-4 tab:px-8">
          <h1 className="text-[28px] leading-none font-medium tracking-tight">My documents</h1>
        </header>

        <div className="px-4 py-6 tab:px-8">
          <input ref={pickerRef} type="file" className="hidden" onChange={onPick} />

          {docsQuery.isLoading ? (
            <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Loading your documents…
            </div>
          ) : docsQuery.isError ? (
            <div className="flex max-w-3xl flex-col items-start gap-3 rounded-md border border-destructive/25 bg-destructive/10 px-6 py-8 text-[13px] text-destructive">
              <p>Couldn't load your documents. Please try again.</p>
              <Button size="sm" variant="outline" onClick={() => docsQuery.refetch()}>
                Retry
              </Button>
            </div>
          ) : (
            <div className="max-w-3xl overflow-hidden rounded-md border border-border bg-card">
              {DOC_CATALOG.map((cat) => {
                const doc = docsQuery.data?.find((d) => d.docType === cat.type);
                const canUpload = !doc || doc.status === "REJECTED";
                return (
                  <div key={cat.type} className="border-b border-border px-4 py-3 last:border-0">
                    <div className="flex min-h-[42px] flex-col gap-3 tab:flex-row tab:flex-wrap tab:items-center tab:gap-4">
                      <div className="text-[13px] text-foreground tab:min-w-[220px]">{cat.label}</div>
                      <div className="text-[13px] text-muted-foreground">
                        {doc ? (
                          <a href={doc.fileUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                            View uploaded file
                          </a>
                        ) : (
                          "Not uploaded"
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-3 tab:ml-auto">
                        {doc && <DocBadge status={doc.status} />}
                        {canUpload && (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={upload.isPending}
                            className="h-11 text-[12px] tab:h-8"
                            onClick={() => {
                              setTargetParam(cat.param);
                              pickerRef.current?.click();
                            }}
                          >
                            {upload.isPending && targetParam === cat.param && (
                              <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                            )}
                            {doc ? "Re-upload" : "Upload"}
                          </Button>
                        )}
                      </div>
                    </div>

                    {doc?.status === "REJECTED" && doc.rejectionReason && (
                      <p className="mt-1.5 text-[12px] text-destructive">
                        Rejected{doc.reviewedAt ? ` on ${formatDate(doc.reviewedAt)}` : ""} — {doc.rejectionReason}
                      </p>
                    )}
                    {doc?.status === "VERIFIED" && doc.reviewedAt && (
                      <p className="mt-1.5 text-[12px] text-muted-foreground">
                        Verified on {formatDate(doc.reviewedAt)}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

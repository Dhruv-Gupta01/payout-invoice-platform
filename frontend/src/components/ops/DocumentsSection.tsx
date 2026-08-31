import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";

// LLD §2.7: Document.docType enum.
export type DocType = "AADHAAR" | "PAN" | "PHOTO" | "BANK_PROOF" | "NDA";
export type DocStatus = "PENDING_REVIEW" | "VERIFIED" | "REJECTED";

export type DocumentItem = {
  id: string;
  docType: DocType;
  fileUrl: string;
  status: DocStatus;
  rejectionReason: string | null;
  reviewedAt: string | null;
  uploadedAt: string;
};

// Fixed catalog of the 5 document types onboarding collects (LLD §2.7) — the
// backend only returns rows the resource has actually uploaded, so this list
// drives the display; a type with no matching upload shows "Not uploaded".
const DOC_CATALOG: { type: DocType; label: string }[] = [
  { type: "AADHAAR", label: "Aadhaar card" },
  { type: "PAN", label: "PAN card" },
  { type: "PHOTO", label: "Passport-size photo" },
  { type: "BANK_PROOF", label: "Bank passbook / cancelled cheque" },
  { type: "NDA", label: "Signed NDA" },
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
      className={
        "fade-in-150 inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold " +
        badgeStyles[status]
      }
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

export function DocumentsSection({ resourceId, documents }: { resourceId: string; documents: DocumentItem[] }) {
  const queryClient = useQueryClient();
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["admin", "resources", resourceId] });

  const verify = useMutation({
    mutationFn: (documentId: string) => api.post(`/admin/documents/${documentId}/verify`),
    onSuccess: invalidate,
  });
  const reject = useMutation({
    mutationFn: (documentId: string) => api.post(`/admin/documents/${documentId}/reject`, { reason }),
    onSuccess: () => {
      setRejectingId(null);
      setReason("");
      invalidate();
    },
  });

  const busy = verify.isPending || reject.isPending;

  return (
    <div>
      <h2 className="mb-3 text-[20px] leading-none font-medium tracking-tight">Documents</h2>
      <div className="overflow-hidden rounded-md border border-border bg-card">
        {DOC_CATALOG.map((cat) => {
          const doc = documents.find((d) => d.docType === cat.type);
          return (
            <div key={cat.type} className="border-b border-border px-4 py-3 last:border-0">
              <div className="flex min-h-[42px] flex-col gap-3 tab:flex-row tab:flex-wrap tab:items-center tab:gap-4">
                <div className="text-[13px] text-foreground tab:min-w-[220px]">{cat.label}</div>
                {doc ? (
                  <>
                    <a
                      href={doc.fileUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[13px] text-primary underline-offset-4 hover:underline"
                    >
                      View
                    </a>
                    <div className="flex flex-wrap items-center gap-3 tab:ml-auto">
                      <DocBadge status={doc.status} />
                      {doc.status === "PENDING_REVIEW" && (
                        <div className="flex w-full gap-2 tab:w-auto">
                          <Button
                            size="sm"
                            disabled={busy}
                            className="h-11 flex-1 text-[12px] tab:h-8 tab:flex-none"
                            onClick={() => verify.mutate(doc.id)}
                          >
                            Verify
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busy}
                            className="h-11 flex-1 border-destructive/30 text-[12px] text-destructive hover:bg-destructive/10 hover:text-destructive tab:h-8 tab:flex-none"
                            onClick={() => {
                              setRejectingId(doc.id);
                              setReason("");
                            }}
                          >
                            Reject
                          </Button>
                        </div>
                      )}
                    </div>
                  </>
                ) : (
                  <span className="text-[12px] text-muted-foreground tab:ml-auto">Not uploaded</span>
                )}
              </div>

              {doc && doc.status !== "PENDING_REVIEW" && doc.reviewedAt && (
                <p className="mt-1.5 text-[12px] text-muted-foreground">
                  {doc.status === "VERIFIED" ? "Verified" : "Rejected"} on {formatDate(doc.reviewedAt)}
                  {doc.status === "REJECTED" && doc.rejectionReason ? ` — ${doc.rejectionReason}` : ""}
                </p>
              )}

              {doc && rejectingId === doc.id && (
                <div className="fade-in-150 mt-3 flex flex-col items-stretch gap-2 tab:flex-row tab:flex-wrap tab:items-end">
                  <div className="flex-1 tab:min-w-[280px]">
                    <label className="mb-1.5 block text-[12px] text-muted-foreground">
                      Reason for rejection
                    </label>
                    <Input
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      placeholder="e.g. Photo is blurry, please re-upload"
                      className="h-11 bg-card text-[13px] tab:h-9"
                    />
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-11 flex-1 text-[12px] tab:h-9 tab:flex-none"
                      onClick={() => setRejectingId(null)}
                    >
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      disabled={!reason.trim() || busy}
                      className="h-11 flex-1 text-[12px] tab:h-9 tab:flex-none"
                      onClick={() => reject.mutate(doc.id)}
                    >
                      Confirm rejection
                    </Button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

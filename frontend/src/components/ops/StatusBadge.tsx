export type InvoiceStatus = "Pending" | "Approved" | "Declined" | "Not Generated";

const styles: Record<InvoiceStatus, string> = {
  Approved: "border-success/25 bg-success/10 text-success",
  Pending: "border-warning/25 bg-warning/10 text-warning",
  Declined: "border-destructive/25 bg-destructive/10 text-destructive",
  "Not Generated": "border-border bg-muted text-muted-foreground",
};

export function StatusBadge({ status }: { status: InvoiceStatus }) {
  return (
    <span
      className={
        "fade-in-150 inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold " +
        styles[status]
      }
    >
      {status}
    </span>
  );
}

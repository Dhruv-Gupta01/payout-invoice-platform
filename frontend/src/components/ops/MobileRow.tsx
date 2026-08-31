import type { ReactNode } from "react";

/** Stacked label/value pair used when tables collapse into cards on mobile. */
export function MobileField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="text-[12px] text-muted-foreground">{label}</span>
      <span className="text-right text-[13px] text-foreground">{children}</span>
    </div>
  );
}

export function MobileCard({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-md border border-border bg-card p-4">
      <div className="flex flex-col gap-2">{children}</div>
    </div>
  );
}

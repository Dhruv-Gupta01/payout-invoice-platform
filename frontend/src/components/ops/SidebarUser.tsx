export function SidebarUser({
  name,
  role,
  compact = false,
}: {
  name: string;
  role: string;
  compact?: boolean;
}) {
  if (compact) {
    return (
      <span
        title={`${name} · ${role}`}
        className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground"
      >
        {name.charAt(0).toUpperCase()}
      </span>
    );
  }
  return (
    <div className="flex items-center gap-2 px-3 py-2">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
        {name.charAt(0).toUpperCase()}
      </span>
      <span className="truncate text-[12px] text-muted-foreground">
        {name} · {role}
      </span>
    </div>
  );
}

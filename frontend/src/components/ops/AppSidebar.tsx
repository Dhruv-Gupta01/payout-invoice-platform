import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Menu, X } from "lucide-react";

import { SidebarUser } from "./SidebarUser";
import { ThemeToggle } from "./ThemeToggle";
import { useCurrentUser, useLogout } from "@/lib/useCurrentUser";

const nav = [
  { label: "Dashboard", to: "/dashboard" as const },
  { label: "Resources", to: "/resources" as const },
  { label: "Reconciliation", to: "/reconciliation" as const },
  { label: "Settings", to: null },
];

function NavItems({ active, onNavigate }: { active: string; onNavigate?: () => void }) {
  return (
    <nav className="flex flex-col gap-0.5 p-2">
      {nav.map((item) => {
        const isActive = item.label === active;
        if (!item.to) {
          return (
            <span
              key={item.label}
              title="Not built yet"
              aria-disabled="true"
              className="flex min-h-11 cursor-not-allowed items-center rounded-md px-3 py-2 text-[13px] text-muted-foreground/60 tab:min-h-0"
            >
              {item.label}
            </span>
          );
        }
        return (
          <Link
            key={item.label}
            to={item.to}
            onClick={onNavigate}
            className={
              "flex min-h-11 items-center rounded-md px-3 py-2 text-[13px] transition-colors duration-150 tab:min-h-0 " +
              (isActive
                ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground")
            }
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

export function AppSidebar({ active = "Dashboard" }: { active?: string }) {
  const [open, setOpen] = useState(false);
  const { data: user } = useCurrentUser();
  const name = user?.name ?? "Admin";
  const logout = useLogout();

  return (
    <>
      {/* Desktop / tablet fixed sidebar */}
      <aside className="fixed inset-y-0 left-0 hidden w-[220px] flex-col border-r border-sidebar-border bg-sidebar tab:flex">
        <div className="flex h-14 items-center border-b border-sidebar-border px-4">
          <span className="text-[13px] font-medium tracking-tight text-sidebar-foreground">
            Payouts Console
          </span>
        </div>
        <NavItems active={active} />
        <div className="mt-auto border-t border-sidebar-border p-2">
          <SidebarUser name={name} role="Admin" />
          <button
            type="button"
            onClick={() => logout.mutate()}
            disabled={logout.isPending}
            className="flex w-full items-center rounded-md px-3 py-2 text-[13px] text-muted-foreground transition-colors duration-150 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"
          >
            {logout.isPending ? "Logging out…" : "Log out"}
          </button>
          <ThemeToggle />
        </div>
      </aside>

      {/* Mobile top bar */}
      <div className="fixed inset-x-0 top-0 z-40 flex h-14 items-center gap-2 border-b border-sidebar-border bg-sidebar px-2 tab:hidden">
        <button
          type="button"
          aria-label="Open navigation"
          onClick={() => setOpen(true)}
          className="flex size-11 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"
        >
          <Menu className="size-4" />
        </button>
        <span className="text-[13px] font-medium tracking-tight text-sidebar-foreground">
          Payouts Console
        </span>
      </div>

      {/* Mobile slide-out */}
      {open && (
        <div className="fixed inset-0 z-50 tab:hidden">
          <button
            type="button"
            aria-label="Close navigation"
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-foreground/30"
          />
          <aside className="fade-in-150 absolute inset-y-0 left-0 flex w-[240px] flex-col border-r border-sidebar-border bg-sidebar">
            <div className="flex h-14 items-center justify-between border-b border-sidebar-border pl-4 pr-2">
              <span className="text-[13px] font-medium tracking-tight text-sidebar-foreground">
                Payouts Console
              </span>
              <button
                type="button"
                aria-label="Close navigation"
                onClick={() => setOpen(false)}
                className="flex size-11 items-center justify-center rounded-md text-muted-foreground hover:text-sidebar-foreground"
              >
                <X className="size-4" />
              </button>
            </div>
            <NavItems active={active} onNavigate={() => setOpen(false)} />
            <div className="mt-auto border-t border-sidebar-border p-2">
              <SidebarUser name={name} role="Admin" />
              <button
                type="button"
                onClick={() => logout.mutate()}
                disabled={logout.isPending}
                className="flex w-full items-center rounded-md px-3 py-2 text-[13px] text-muted-foreground transition-colors duration-150 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"
              >
                {logout.isPending ? "Logging out…" : "Log out"}
              </button>
              <ThemeToggle />
            </div>
          </aside>
        </div>
      )}
    </>
  );
}

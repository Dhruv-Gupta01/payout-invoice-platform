import { Link } from "@tanstack/react-router";
import { LogOut } from "lucide-react";

import { SidebarUser } from "./SidebarUser";
import { ThemeToggle } from "./ThemeToggle";
import { useCurrentUser, useLogout } from "@/lib/useCurrentUser";

const nav = [
  { label: "My Profile", to: "/profile" },
  { label: "My Invoices", to: "/invoices" },
  { label: "Documents", to: "/documents" },
];

export function ResourceSidebar({ active = "My Profile" }: { active?: string }) {
  const { data: user } = useCurrentUser();
  const name = user?.name ?? "Resource";
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
        <nav className="flex flex-col gap-0.5 p-2">
          {nav.map((item) => {
            const isActive = item.label === active;
            return (
              <Link
                key={item.label}
                to={item.to}
                className={
                  "rounded-md px-3 py-2 text-[13px] transition-colors duration-150 " +
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
        <div className="mt-auto border-t border-sidebar-border p-2">
          <SidebarUser name={name} role="Resource" />
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
      <div className="fixed inset-x-0 top-0 z-40 flex h-14 items-center justify-between gap-2 border-b border-sidebar-border bg-sidebar px-3 tab:hidden">
        <span className="text-[13px] font-medium tracking-tight text-sidebar-foreground">
          Payouts Console
        </span>
        <div className="flex items-center gap-1">
          <SidebarUser name={name} role="Resource" compact />
          <button
            type="button"
            aria-label="Log out"
            onClick={() => logout.mutate()}
            disabled={logout.isPending}
            className="flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"
          >
            <LogOut className="size-4" />
          </button>
          <div className="w-auto">
            <ThemeToggle compact />
          </div>
        </div>
      </div>

      {/* Mobile bottom tab bar */}
      <nav className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-3 border-t border-sidebar-border bg-sidebar tab:hidden">
        {nav.map((item) => {
          const isActive = item.label === active;
          return (
            <Link
              key={item.label}
              to={item.to}
              className={
                "flex min-h-14 items-center justify-center px-2 text-center text-[12px] transition-colors duration-150 " +
                (isActive
                  ? "font-medium text-sidebar-accent-foreground"
                  : "text-muted-foreground")
              }
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
    </>
  );
}

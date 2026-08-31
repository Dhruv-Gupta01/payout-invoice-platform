import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";

const KEY = "payouts-theme";

export function applyStoredTheme() {
  if (typeof window === "undefined") return;
  const stored = window.localStorage.getItem(KEY);
  document.documentElement.classList.toggle("dark", stored === "dark");
}

export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const [dark, setDark] = useState(false);


  useEffect(() => {
    const stored = window.localStorage.getItem(KEY) === "dark";
    setDark(stored);
    document.documentElement.classList.toggle("dark", stored);
  }, []);

  const toggle = () => {
    const next = !dark;
    setDark(next);
    window.localStorage.setItem(KEY, next ? "dark" : "light");
    document.documentElement.classList.toggle("dark", next);
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      className={
        compact
          ? "flex size-11 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:text-sidebar-foreground"
          : "flex w-full items-center gap-2 rounded-md px-3 py-2 text-[13px] text-muted-foreground transition-colors duration-150 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"
      }
    >
      {dark ? <Moon size={14} /> : <Sun size={14} />}
      {!compact && (dark ? "Dark mode" : "Light mode")}
    </button>
  );
}


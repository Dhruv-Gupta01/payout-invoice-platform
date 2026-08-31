import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, ApiError } from "@/lib/api";

// LLD §2.1: POST /auth/login → { id, email, name, role: "admin" | "resource" }
type LoginResponse = { id: string; email: string; name: string; role: "admin" | "resource" };
// LLD §2.6 (onboardingCompleted added per §0.21): only the field needed here.
type ProfileResponse = { onboardingCompleted: boolean };

export const Route = createFileRoute("/login")({
  head: () => ({
    meta: [
      { title: "Log in — Payouts Console" },
      {
        name: "description",
        content: "Internal login for the Payouts Console.",
      },
      { property: "og:title", content: "Log in — Payouts Console" },
      {
        property: "og:description",
        content: "Internal login for the Payouts Console.",
      },
    ],
  }),
  component: LoginPage,
});

function LoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password.trim()) {
      setError("Enter your email and password.");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const user = await api.post<LoginResponse>("/auth/login", { email, password });
      if (user.role === "admin") {
        navigate({ to: "/dashboard" });
        return;
      }
      const profile = await api.get<ProfileResponse>("/resource/profile");
      navigate({ to: profile.onboardingCompleted ? "/invoices" : "/onboarding" });
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? "Invalid email or password." : "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 fade-in-150">
      <div className="w-full max-w-[400px] rounded-md border border-border bg-card p-6 tab:p-8">
        <div className="mb-6">
          <p className="text-[12px] font-medium uppercase tracking-wider text-muted-foreground">
            Payouts Console
          </p>
          <h1 className="mt-1 text-[20px] font-medium tracking-tight text-foreground">Log in</h1>
        </div>

        <form onSubmit={submit} className="flex flex-col gap-4">
          <div>
            <label htmlFor="email" className="mb-1 block text-[13px] text-foreground">
              Email
            </label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="h-11 bg-card text-[14px]"
            />
          </div>

          <div>
            <label htmlFor="password" className="mb-1 block text-[13px] text-foreground">
              Password
            </label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className="h-11 bg-card text-[14px]"
            />
          </div>

          {error && <p className="text-[13px] text-destructive">{error}</p>}

          <Button type="submit" disabled={submitting} className="h-11 w-full text-[13px] font-medium">
            {submitting ? "Logging in…" : "Log in"}
          </Button>
        </form>

        <div className="mt-4 flex flex-col gap-2 text-[12px] text-muted-foreground tab:flex-row tab:items-center tab:justify-between">
          <span>Contact your admin if you don't have an account</span>
          <button
            type="button"
            className="self-start text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            onClick={() => setError("Contact your admin to reset your password.")}
          >
            Forgot password?
          </button>
        </div>
      </div>
    </div>
  );
}

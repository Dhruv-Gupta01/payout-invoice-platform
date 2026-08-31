import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, ApiError } from "@/lib/api";

// LLD §0.25 / §2.1: POST /auth/accept-invite → { id, email, name, role: "resource" }
type AcceptInviteResponse = { id: string; email: string; name: string; role: "resource" };
type ProfileResponse = { onboardingCompleted: boolean };

export const Route = createFileRoute("/accept-invite")({
  validateSearch: (search: Record<string, unknown>) => ({
    token: typeof search["token"] === "string" ? (search["token"] as string) : "",
  }),
  head: () => ({
    meta: [
      { title: "Set your password — Payouts Console" },
      { name: "description", content: "Accept your invite and set a password for the Payouts Console." },
    ],
  }),
  component: AcceptInvitePage,
});

const MIN_PASSWORD_LENGTH = 8;

function AcceptInvitePage() {
  const navigate = useNavigate();
  const { token } = Route.useSearch();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) {
      setError("This invite link is missing its token. Ask your admin to resend it.");
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords don't match.");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await api.post<AcceptInviteResponse>("/auth/accept-invite", { token, password });
      const profile = await api.get<ProfileResponse>("/resource/profile");
      navigate({ to: profile.onboardingCompleted ? "/invoices" : "/onboarding" });
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 400
          ? "This invite link is invalid or has expired. Ask your admin to send a new one."
          : "Something went wrong. Please try again."
      );
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
          <h1 className="mt-1 text-[20px] font-medium tracking-tight text-foreground">
            Set your password
          </h1>
          <p className="mt-2 text-[13px] text-muted-foreground">
            Choose a password to activate your account.
          </p>
        </div>

        <form onSubmit={submit} className="flex flex-col gap-4">
          <div>
            <label htmlFor="password" className="mb-1 block text-[13px] text-foreground">
              New password
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

          <div>
            <label htmlFor="confirm-password" className="mb-1 block text-[13px] text-foreground">
              Confirm password
            </label>
            <Input
              id="confirm-password"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="••••••••"
              className="h-11 bg-card text-[14px]"
            />
          </div>

          {error && <p className="text-[13px] text-destructive">{error}</p>}

          <Button type="submit" disabled={submitting} className="h-11 w-full text-[13px] font-medium">
            {submitting ? "Setting password…" : "Set password and continue"}
          </Button>
        </form>
      </div>
    </div>
  );
}

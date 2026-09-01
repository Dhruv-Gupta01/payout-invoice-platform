import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2 } from "lucide-react";

import { ResourceSidebar } from "@/components/ops/ResourceSidebar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";

export const Route = createFileRoute("/profile")({
  head: () => ({
    meta: [
      { title: "My Profile — Payouts Console" },
      {
        name: "description",
        content: "View your locked contact and bank details used for payouts.",
      },
      { property: "og:title", content: "My Profile — Payouts Console" },
      {
        property: "og:description",
        content: "View your locked contact and bank details used for payouts.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: ProfilePage,
});

// LLD §2.6: GET /resource/profile
type Profile = {
  name: string;
  email: string;
  address: string | null;
  contactNo: string | null;
  pan: string | null;
  beneficiaryName: string | null;
  accountNo: string | null;
  bankName: string | null;
  ifsc: string | null;
  bankLocked: boolean;
  onboardingCompleted: boolean;
};

type EditableFields = {
  address: string;
  contactNo: string;
  pan: string;
  beneficiaryName: string;
  accountNo: string;
  bankName: string;
  ifsc: string;
};

const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function todayLabel() {
  const d = new Date();
  return `${d.getDate()} ${monthNames[d.getMonth()]} ${d.getFullYear()}`;
}

function toFormValues(profile: Profile): EditableFields {
  return {
    address: profile.address ?? "",
    contactNo: profile.contactNo ?? "",
    pan: profile.pan ?? "",
    beneficiaryName: profile.beneficiaryName ?? "",
    accountNo: profile.accountNo ?? "",
    bankName: profile.bankName ?? "",
    ifsc: profile.ifsc ?? "",
  };
}

function ProfilePage() {
  const queryClient = useQueryClient();
  const profileQuery = useQuery({
    queryKey: ["resource", "profile"],
    queryFn: () => api.get<Profile>("/resource/profile"),
  });
  const [form, setForm] = useState<EditableFields | null>(null);
  const [savedOn, setSavedOn] = useState<string | null>(null);

  // profile.bankLocked === false means an admin has unlocked details and
  // this resource hasn't saved yet (LLD §2.5/§2.6 — same field admin's
  // unlock-bank flips, and PUT /resource/profile flips back to true).
  const editing = profileQuery.data ? !profileQuery.data.bankLocked : false;

  useEffect(() => {
    if (profileQuery.data && editing && !form) {
      setForm(toFormValues(profileQuery.data));
    }
    if (profileQuery.data && !editing) {
      setForm(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileQuery.data, editing]);

  const save = useMutation({
    mutationFn: (fields: EditableFields) => api.put<{ bankLocked: boolean }>("/resource/profile", fields),
    onSuccess: () => {
      setSavedOn(todayLabel());
      queryClient.invalidateQueries({ queryKey: ["resource", "profile"] });
    },
  });

  const set = (key: keyof EditableFields) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => (f ? { ...f, [key]: e.target.value } : f));

  if (profileQuery.isLoading) {
    return (
      <div className="min-h-screen bg-background">
        <ResourceSidebar active="My Profile" />
        <main className="flex items-center gap-2 px-4 pt-20 pb-10 text-[13px] text-muted-foreground tab:ml-[220px] tab:px-8 tab:pt-10">
          <Loader2 className="size-4 animate-spin" />
          Loading your profile…
        </main>
      </div>
    );
  }

  if (profileQuery.isError || !profileQuery.data) {
    return (
      <div className="min-h-screen bg-background">
        <ResourceSidebar active="My Profile" />
        <main className="flex flex-col items-start gap-3 px-4 pt-20 pb-10 tab:ml-[220px] tab:px-8 tab:pt-10">
          <p className="text-[13px] text-destructive">Couldn't load your profile. Please try again.</p>
          <Button size="sm" variant="outline" onClick={() => profileQuery.refetch()}>
            Retry
          </Button>
        </main>
      </div>
    );
  }

  const profile = profileQuery.data;

  return (
    <div className="min-h-screen bg-background">
      <ResourceSidebar active="My Profile" />
      <main className="pt-14 pb-16 tab:ml-[220px] tab:pt-0 tab:pb-0">
        <header className="flex h-14 items-center border-b border-border px-4 tab:px-8">
          <h1 className="text-[28px] leading-none font-medium tracking-tight">My profile</h1>
        </header>

        <div className="px-4 py-6 tab:px-8">
          <div className="max-w-2xl rounded-md border border-border bg-card p-4 tab:p-6">
            {editing ? (
              <div className="mb-6 rounded-md border border-warning/25 bg-warning/10 px-3 py-2 text-[12px] leading-relaxed text-warning">
                Your admin has unlocked your details. Make your changes and save to lock them again.
              </div>
            ) : (
              <p className="mb-6 text-[12px] leading-relaxed text-muted-foreground">
                These details were set during onboarding and are locked. Contact your admin to
                request a change.
              </p>
            )}

            <section>
              <h2 className="mb-5 text-[20px] leading-none font-medium tracking-tight text-foreground">
                Contact details
              </h2>
              <div className="grid gap-5 sm:grid-cols-2">
                <Field label="Name" value={profile.name} />
                <Field label="Email" value={profile.email} />
                <div className="sm:col-span-2">
                  {editing && form ? (
                    <EditField label="Address" value={form.address} onChange={set("address")} />
                  ) : (
                    <Field label="Address" value={profile.address ?? ""} />
                  )}
                </div>
                {editing && form ? (
                  <>
                    <EditField label="Contact number" value={form.contactNo} onChange={set("contactNo")} />
                    <EditField
                      label="PAN"
                      value={form.pan}
                      onChange={set("pan")}
                      className="num uppercase"
                    />
                  </>
                ) : (
                  <>
                    <Field label="Contact number" value={profile.contactNo ?? ""} />
                    <Field label="PAN" value={profile.pan ?? ""} mono />
                  </>
                )}
              </div>
            </section>

            <div className="my-6 h-px bg-border" />

            <section>
              <h2 className="mb-3 text-[20px] leading-none font-medium tracking-tight text-foreground">
                Bank details for payment
              </h2>

              {editing && (
                <div className="mb-5 flex gap-2.5 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-[12px] leading-relaxed text-destructive">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                  <div className="space-y-1.5">
                    <p className="font-semibold">Double-check these before saving.</p>
                    <ul className="list-disc space-y-1 pl-4">
                      <li>
                        The <strong>beneficiary name</strong> and <strong>bank name</strong> must exactly
                        match your bank&apos;s records, or the transfer is rejected and{" "}
                        <strong>no payment will be made</strong>.
                      </li>
                      <li>
                        A payment credited to a wrong account number / IFSC{" "}
                        <strong>cannot be reversed or reconsidered</strong>.
                      </li>
                      <li>You get one edit per unlock — it re-locks as soon as you save.</li>
                    </ul>
                  </div>
                </div>
              )}

              <div className="grid gap-5 sm:grid-cols-2">
                {editing && form ? (
                  <>
                    <EditField
                      label="Beneficiary name"
                      value={form.beneficiaryName}
                      onChange={set("beneficiaryName")}
                    />
                    <EditField
                      label="Account number"
                      value={form.accountNo}
                      onChange={set("accountNo")}
                      className="num"
                    />
                    <EditField label="Bank name" value={form.bankName} onChange={set("bankName")} />
                    <EditField
                      label="IFSC code"
                      value={form.ifsc}
                      onChange={set("ifsc")}
                      className="num uppercase"
                    />
                  </>
                ) : (
                  <>
                    <Field label="Beneficiary name" value={profile.beneficiaryName ?? ""} />
                    <Field label="Account number" value={profile.accountNo ?? ""} mono />
                    <Field label="Bank name" value={profile.bankName ?? ""} />
                    <Field label="IFSC code" value={profile.ifsc ?? ""} mono />
                  </>
                )}
              </div>
            </section>

            {editing && form && (
              <div className="mt-6 flex justify-end">
                <Button
                  disabled={save.isPending}
                  className="h-11 w-full px-5 text-[13px] font-medium tab:h-9 tab:w-auto"
                  onClick={() => save.mutate(form)}
                >
                  {save.isPending && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
                  Save and lock
                </Button>
              </div>
            )}
          </div>

          {!editing && savedOn && (
            <p className="mt-3 max-w-2xl text-[12px] text-muted-foreground">
              Saved and locked on {savedOn}
            </p>
          )}
        </div>
      </main>
    </div>
  );
}

function Field({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <label className="mb-1.5 block text-[12px] text-muted-foreground">{label}</label>
      <div className={`min-h-[20px] text-[13px] text-foreground ${mono ? "num" : ""}`}>{value || "—"}</div>
    </div>
  );
}

function EditField({
  label,
  className = "",
  ...props
}: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div>
      <label className="mb-1.5 block text-[12px] text-muted-foreground">{label}</label>
      <Input {...props} className={`h-11 bg-card text-[13px] tab:h-9 ${className}`} />
    </div>
  );
}

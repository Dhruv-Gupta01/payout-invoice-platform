import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, ApiError } from "@/lib/api";

export const Route = createFileRoute("/onboarding")({
  head: () => ({
    meta: [
      { title: "Onboarding — Payouts Console" },
      {
        name: "description",
        content:
          "One-time onboarding for freelance resources: contact details, bank details, and documents.",
      },
      { property: "og:title", content: "Onboarding — Payouts Console" },
      {
        property: "og:description",
        content: "Submit your contact, bank, and document details to start receiving payouts.",
      },
    ],
  }),
  component: OnboardingPage,
});

type FieldKey =
  | "address"
  | "contactNo"
  | "pan"
  | "beneficiaryName"
  | "accountNo"
  | "bankName"
  | "ifsc";

// LLD §2.7: Document.docType enum / URL param.
type DocType = "AADHAAR" | "PAN" | "PHOTO" | "BANK_PROOF" | "NDA";
type DocumentItem = { docType: DocType; status: "PENDING_REVIEW" | "VERIFIED" | "REJECTED" };

const docs: { key: DocType; param: string; label: string }[] = [
  { key: "AADHAAR", param: "aadhaar", label: "Aadhaar card" },
  { key: "PAN", param: "pan", label: "PAN card" },
  { key: "PHOTO", param: "photo", label: "Passport-size photo" },
  { key: "BANK_PROOF", param: "bank_proof", label: "Bank passbook / cancelled cheque" },
  { key: "NDA", param: "nda", label: "Signed NDA" },
];

function OnboardingPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [values, setValues] = useState<Record<FieldKey, string>>({
    address: "",
    contactNo: "",
    pan: "",
    beneficiaryName: "",
    accountNo: "",
    bankName: "",
    ifsc: "",
  });
  const [submitted, setSubmitted] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [uploadingParam, setUploadingParam] = useState<string | null>(null);
  const pickerRef = useRef<HTMLInputElement>(null);
  const [targetParam, setTargetParam] = useState<string | null>(null);

  const docsQuery = useQuery({
    queryKey: ["resource", "documents"],
    queryFn: () => api.get<DocumentItem[]>("/resource/documents"),
  });

  const upload = useMutation({
    mutationFn: ({ param, file }: { param: string; file: File }) =>
      api.upload(`/resource/documents/${param}`, file),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["resource", "documents"] }),
    onSettled: () => setUploadingParam(null),
  });

  const submit = useMutation({
    mutationFn: () => api.post<{ onboardingCompleted: boolean; bankLocked: boolean }>("/resource/onboarding", values),
    onSuccess: () => setSubmitted(true),
    onError: (err) => {
      setSubmitError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    },
  });

  const update = (key: FieldKey, upper = false) =>
    (e: React.ChangeEvent<HTMLInputElement>) =>
      setValues((prev) => ({
        ...prev,
        [key]: upper ? e.target.value.toUpperCase() : e.target.value,
      }));

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && targetParam) {
      setUploadingParam(targetParam);
      upload.mutate({ param: targetParam, file });
    }
    e.target.value = "";
    setTargetParam(null);
  };

  const complete = useMemo(
    () =>
      Object.values(values).every((v) => v.trim() !== "") &&
      docs.every((d) => docsQuery.data?.some((doc) => doc.docType === d.key)),
    [values, docsQuery.data],
  );

  if (submitted) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <div className="fade-in-150 w-full max-w-[560px] rounded-md border border-border bg-card p-6 text-center tab:p-10">
          <div className="mx-auto flex size-10 items-center justify-center rounded-full border border-success/30 bg-success/10">
            <Check className="size-5 text-success" />
          </div>
          <h1 className="mt-4 text-[20px] font-medium tracking-tight text-foreground">
            Onboarding complete
          </h1>
          <p className="mt-2 text-[13px] text-muted-foreground">
            Your details have been submitted and locked.
          </p>
          <Link to="/invoices" className="mt-6 inline-block">
            <Button className="h-11 px-5 text-[13px] font-medium">Continue</Button>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background px-4 py-8 tab:py-12">
      <input ref={pickerRef} type="file" className="hidden" onChange={onPick} />
      <div className="mx-auto w-full max-w-[560px]">
        <h1 className="text-[28px] leading-none font-medium tracking-tight text-foreground">
          Complete your onboarding
        </h1>
        <p className="mt-2 text-[13px] text-muted-foreground">
          These details will be locked after submission. Contact your admin if you need to make
          changes later.
        </p>

        <div className="mt-6 rounded-md border border-border bg-card p-4 tab:p-6">
          <h2 className="mb-5 text-[20px] leading-none font-medium tracking-tight text-foreground">
            Contact details
          </h2>
          <div className="grid gap-5 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Field
                label="Address"
                value={values.address}
                onChange={update("address")}
                placeholder="Enter your address"
              />
            </div>
            <Field
              label="Contact number"
              value={values.contactNo}
              onChange={update("contactNo")}
              placeholder="Enter contact number"
              inputMode="tel"
            />
            <Field
              label="PAN"
              value={values.pan}
              onChange={update("pan", true)}
              placeholder="Enter PAN"
              className="num"
            />
          </div>
        </div>

        <div className="mt-6 rounded-md border border-border bg-card p-4 tab:p-6">
          <h2 className="mb-5 text-[20px] leading-none font-medium tracking-tight text-foreground">
            Bank details for payment
          </h2>
          <div className="grid gap-5 sm:grid-cols-2">
            <Field
              label="Beneficiary name"
              value={values.beneficiaryName}
              onChange={update("beneficiaryName")}
              placeholder="Enter beneficiary name"
            />
            <Field
              label="Account number"
              value={values.accountNo}
              onChange={update("accountNo")}
              placeholder="Enter account number"
              inputMode="numeric"
              className="num"
            />
            <Field
              label="Bank name"
              value={values.bankName}
              onChange={update("bankName")}
              placeholder="Enter bank name"
            />
            <Field
              label="IFSC code"
              value={values.ifsc}
              onChange={update("ifsc", true)}
              placeholder="Enter IFSC code"
              className="num"
            />
          </div>
        </div>

        <div className="mt-6 rounded-md border border-border bg-card p-4 tab:p-6">
          <h2 className="mb-2 text-[20px] leading-none font-medium tracking-tight text-foreground">
            Documents
          </h2>
          <div className="divide-y divide-border">
            {docs.map((d) => {
              const uploaded = docsQuery.data?.some((doc) => doc.docType === d.key);
              return (
                <UploadRow
                  key={d.key}
                  label={d.label}
                  uploaded={Boolean(uploaded)}
                  uploading={uploadingParam === d.param}
                  onPick={() => {
                    setTargetParam(d.param);
                    pickerRef.current?.click();
                  }}
                />
              );
            })}
          </div>
        </div>

        {submitError && <p className="mt-4 text-[13px] text-destructive">{submitError}</p>}

        <Button
          className="mt-6 h-11 w-full text-[13px] font-medium"
          disabled={!complete || submit.isPending}
          onClick={() => {
            setSubmitError(null);
            submit.mutate();
          }}
        >
          {submit.isPending && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
          Submit and lock
        </Button>
      </div>
    </div>
  );
}

function Field({
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

function UploadRow({
  label,
  uploaded,
  uploading,
  onPick,
}: {
  label: string;
  uploaded: boolean;
  uploading: boolean;
  onPick: () => void;
}) {
  return (
    <div className="flex min-h-[48px] flex-col items-start justify-between gap-3 py-3 tab:flex-row tab:items-center tab:gap-4">
      <div>
        <p className="text-[13px] text-foreground">{label}</p>
        {uploaded ? (
          <p className="fade-in-150 mt-0.5 flex items-center gap-1.5 text-[12px] text-success">
            <Check className="size-3.5" />
            Uploaded
          </p>
        ) : (
          <p className="mt-0.5 text-[12px] text-muted-foreground">No file uploaded</p>
        )}
      </div>
      <Button
        variant="outline"
        size="sm"
        disabled={uploading}
        className="h-11 w-full shrink-0 gap-1.5 text-[12px] tab:h-8 tab:w-auto"
        onClick={onPick}
      >
        {uploading ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
        {uploaded ? "Replace" : "Upload"}
      </Button>
    </div>
  );
}

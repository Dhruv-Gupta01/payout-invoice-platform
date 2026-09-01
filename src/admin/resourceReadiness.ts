import { DocumentType } from "@prisma/client";
import { prisma } from "../lib/prisma";

// LLD §0.23 (new rule, user-requested): invoice generation must not proceed
// for a resource who hasn't finished onboarding or whose documents aren't
// all verified — checked and reported separately from duplicate/
// stale-amount detection (§3). Unlike those, these two are NOT an admin
// judgment call — see acknowledgeFlag in invoiceGenerationService.ts, which
// re-checks specifically these two conditions and refuses to override them.
const REQUIRED_DOC_TYPES: { type: DocumentType; label: string }[] = [
  { type: "AADHAAR", label: "Aadhaar card" },
  { type: "PAN", label: "PAN card" },
  { type: "PHOTO", label: "Passport-size photo" },
  { type: "BANK_PROOF", label: "Bank passbook / cancelled cheque" },
  { type: "NDA", label: "Signed NDA" },
  { type: "ICA", label: "Signed ICA" },
];

export function checkOnboardingIncomplete(resource: { onboardingCompleted: boolean }): string | null {
  return resource.onboardingCompleted ? null : "Resource has not completed onboarding";
}

// "Documents verified" means all 6 required types have a Document row with
// status VERIFIED — missing, pending-review, and rejected all count as "not
// ready" (LLD §0.23).
export async function checkDocumentsNotVerified(resourceId: string): Promise<string | null> {
  const documents = await prisma.document.findMany({
    where: { resourceId, status: "VERIFIED" },
    select: { docType: true },
  });
  const verifiedTypes = new Set(documents.map((d) => d.docType));
  const missing = REQUIRED_DOC_TYPES.filter((d) => !verifiedTypes.has(d.type));

  if (missing.length === 0) return null;
  return `${missing.length} document(s) not yet verified (${missing.map((d) => d.label).join(", ")})`;
}

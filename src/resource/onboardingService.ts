import { prisma } from "../lib/prisma";
import { JobQueue } from "../queue/JobQueue";
import { autoClearReadyFlags } from "../admin/invoiceGenerationService";
import { validateProfileFieldFormats, FieldValidationError } from "../lib/fieldValidation";

// LLD §2.6
// POST /resource/onboarding   (one-time; rejected if onboardingCompleted already true)
// Request: { address, contactNo, pan, beneficiaryName, accountNo, bankName, ifsc }
// Response 200: { onboardingCompleted: true, bankLocked: true }
//
// Per the Phase 5 scope correction (BuildPlan.md): profile/bank fields only
// — document upload is a separate flow (LLD §2.7).
export interface OnboardingInput {
  address: string;
  contactNo: string;
  pan: string;
  beneficiaryName: string;
  accountNo: string;
  bankName: string;
  ifsc: string;
}

export class OnboardingAlreadyCompletedError extends Error {}

const REQUIRED_FIELDS: (keyof OnboardingInput)[] = [
  "address",
  "contactNo",
  "pan",
  "beneficiaryName",
  "accountNo",
  "bankName",
  "ifsc",
];

export async function completeOnboarding(resourceId: string, input: OnboardingInput, jobQueue: JobQueue) {
  const resource = await prisma.resource.findUniqueOrThrow({ where: { id: resourceId } });
  if (resource.onboardingCompleted) {
    throw new OnboardingAlreadyCompletedError();
  }

  for (const field of REQUIRED_FIELDS) {
    if (!input[field] || !input[field].trim()) {
      throw new FieldValidationError(field, `${field} is required`);
    }
  }
  validateProfileFieldFormats(input);

  // PAN/IFSC are stored uppercase — the frontend already uppercases as you
  // type, but a direct API call shouldn't be able to skip that.
  const normalized: OnboardingInput = {
    ...input,
    address: input.address.trim(),
    contactNo: input.contactNo.trim(),
    pan: input.pan.trim().toUpperCase(),
    beneficiaryName: input.beneficiaryName.trim(),
    accountNo: input.accountNo.trim(),
    bankName: input.bankName.trim(),
    ifsc: input.ifsc.trim().toUpperCase(),
  };

  await prisma.resource.update({
    where: { id: resourceId },
    data: {
      ...normalized,
      onboardingCompleted: true,
      bankLocked: true,
    },
  });

  // Re-checks this resource's FLAGGED invoices (user-requested — see
  // autoClearReadyFlags in invoiceGenerationService.ts).
  await autoClearReadyFlags(resourceId, jobQueue);

  return { onboardingCompleted: true, bankLocked: true };
}

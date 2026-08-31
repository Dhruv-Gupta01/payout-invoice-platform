import { prisma } from "../lib/prisma";
import { JobQueue } from "../queue/JobQueue";
import { autoClearReadyFlags } from "../admin/invoiceGenerationService";

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

export async function completeOnboarding(resourceId: string, input: OnboardingInput, jobQueue: JobQueue) {
  const resource = await prisma.resource.findUniqueOrThrow({ where: { id: resourceId } });
  if (resource.onboardingCompleted) {
    throw new OnboardingAlreadyCompletedError();
  }

  await prisma.resource.update({
    where: { id: resourceId },
    data: {
      ...input,
      onboardingCompleted: true,
      bankLocked: true,
    },
  });

  // Re-checks this resource's FLAGGED invoices (user-requested — see
  // autoClearReadyFlags in invoiceGenerationService.ts).
  await autoClearReadyFlags(resourceId, jobQueue);

  return { onboardingCompleted: true, bankLocked: true };
}

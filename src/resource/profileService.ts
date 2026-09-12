import { prisma } from "../lib/prisma";
import { validateProfileFieldFormats } from "../lib/fieldValidation";

export class ProfileLockedError extends Error {}

// LLD §2.6
// GET /resource/profile
// Response 200: { name, email, address, contactNo, pan, beneficiaryName, accountNo, bankName, ifsc, bankLocked, onboardingCompleted }
// onboardingCompleted added per §0.21 — lets the frontend redirect a freshly
// logged-in resource to /onboarding vs /invoices.
export async function getProfile(resourceId: string) {
  const resource = await prisma.resource.findUniqueOrThrow({ where: { id: resourceId } });
  return {
    name: resource.name,
    email: resource.email,
    address: resource.address,
    contactNo: resource.contactNo,
    pan: resource.pan,
    beneficiaryName: resource.beneficiaryName,
    accountNo: resource.accountNo,
    bankName: resource.bankName,
    ifsc: resource.ifsc,
    bankLocked: resource.bankLocked,
    onboardingCompleted: resource.onboardingCompleted,
  };
}

export interface ProfileUpdateInput {
  address?: string;
  contactNo?: string;
  pan?: string;
  beneficiaryName?: string;
  accountNo?: string;
  bankName?: string;
  ifsc?: string;
}

// LLD §2.6
// PUT /resource/profile
// Request: { address?, contactNo?, pan?, beneficiaryName?, accountNo?, bankName?, ifsc? }
// Response 200: { updated fields..., bankLocked: true }
// Response 403: { error: "Details are locked. Ask your admin to unlock them." }
//   // allowed only if an open BankUnlockLog exists for this resource
//   // (unlockedAt set, editedAt null)
// HLD §5.5 step 3: "On save: fields updated, bank_locked = true again,
// unlock log entry closed (edited_at, re_locked_at)."
export async function updateProfile(resourceId: string, input: ProfileUpdateInput) {
  const openLog = await prisma.bankUnlockLog.findFirst({
    where: { resourceId, editedAt: null },
  });
  if (!openLog) {
    throw new ProfileLockedError();
  }

  validateProfileFieldFormats(input);
  const normalized: ProfileUpdateInput = {
    ...input,
    ...(input.address !== undefined && { address: input.address.trim() }),
    ...(input.contactNo !== undefined && { contactNo: input.contactNo.trim() }),
    ...(input.pan !== undefined && { pan: input.pan.trim().toUpperCase() }),
    ...(input.beneficiaryName !== undefined && { beneficiaryName: input.beneficiaryName.trim() }),
    ...(input.accountNo !== undefined && { accountNo: input.accountNo.trim() }),
    ...(input.bankName !== undefined && { bankName: input.bankName.trim() }),
    ...(input.ifsc !== undefined && { ifsc: input.ifsc.trim().toUpperCase() }),
  };

  await prisma.resource.update({
    where: { id: resourceId },
    data: { ...normalized, bankLocked: true },
  });

  const now = new Date();
  // updateMany (not just the one log found above) in case more than one
  // unlock window was somehow left open — closes all of them on save.
  await prisma.bankUnlockLog.updateMany({
    where: { resourceId, editedAt: null },
    data: { editedAt: now, reLockedAt: now },
  });

  return { ...normalized, bankLocked: true };
}

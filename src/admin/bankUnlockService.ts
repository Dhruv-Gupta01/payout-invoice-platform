import { prisma } from "../lib/prisma";
import { EmailProvider } from "../providers/EmailProvider";
import { notify } from "../notifications/notifier";

// LLD §2.5
// POST /admin/resources/:id/unlock-bank
// Response 200: { resourceId, unlockedAt }
// HLD §5.5 step 1: "Admin clicks Unlock on a resource → logged in
// BankUnlockLog, resource notified by email." HLD §7 (Phase 4 reminder):
// "Bank details unlocked | Resource | Admin clicks Unlock"
export async function unlockBank(resourceId: string, adminId: string, emailProvider: EmailProvider) {
  const resource = await prisma.resource.findUniqueOrThrow({ where: { id: resourceId } });

  const log = await prisma.bankUnlockLog.create({
    data: { resourceId, unlockedById: adminId },
  });

  // Kept in sync with the open BankUnlockLog so GET /resource/profile's
  // bankLocked field reflects reality — the actual PUT /resource/profile
  // guard (LLD §2.6) checks for an open BankUnlockLog directly, not this flag.
  await prisma.resource.update({ where: { id: resourceId }, data: { bankLocked: false } });

  await notify(emailProvider, "BANK_UNLOCKED", resource.email, "resource", resourceId);

  return { resourceId, unlockedAt: log.unlockedAt };
}

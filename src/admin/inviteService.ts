import { randomBytes } from "crypto";
import { prisma } from "../lib/prisma";
import { EmailProvider } from "../providers/EmailProvider";
import { notify } from "../notifications/notifier";

const INVITE_VALIDITY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days (LLD §0.25, flagged default)

// LLD §0.25
// POST /admin/resources/:id/send-invite   (manual, admin-triggered — user-confirmed,
//   not automatic on sync, since real sheet data can be messy/duplicated)
// Response 200: { resourceId, inviteExpiresAt }
//
// Generates a fresh token, overwriting any prior unused one — that's how
// "resend" works, no separate endpoint. Fires INVITE_SENT to the resource.
export async function sendInvite(resourceId: string, emailProvider: EmailProvider) {
  const inviteToken = randomBytes(32).toString("hex");
  const inviteTokenExpiresAt = new Date(Date.now() + INVITE_VALIDITY_MS);

  const resource = await prisma.resource.update({
    where: { id: resourceId },
    data: { inviteToken, inviteTokenExpiresAt },
  });

  await notify(emailProvider, "INVITE_SENT", resource.email, "resource", resource.id);

  return { resourceId: resource.id, inviteExpiresAt: resource.inviteTokenExpiresAt };
}

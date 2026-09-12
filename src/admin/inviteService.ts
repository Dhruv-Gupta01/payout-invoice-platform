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

// POST /admin/resources/invite (new endpoint, user-requested — group/bulk
// invite from the Resources list, so the admin isn't opening each resource's
// detail page one at a time). Reuses sendInvite per id, sequentially — invite
// volume here is small (a batch of new sheet resources, not a mass-email
// job) and this keeps one resource's failure (e.g. a since-deleted id) from
// aborting the rest. Reports success/failure per id rather than throwing on
// the first bad one, same reporting shape as sync's per-row skip list.
export async function sendInvites(resourceIds: string[], emailProvider: EmailProvider) {
  const results: { resourceId: string; inviteExpiresAt?: Date | null; error?: string }[] = [];
  for (const resourceId of resourceIds) {
    try {
      const result = await sendInvite(resourceId, emailProvider);
      results.push(result);
    } catch (err) {
      results.push({ resourceId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}

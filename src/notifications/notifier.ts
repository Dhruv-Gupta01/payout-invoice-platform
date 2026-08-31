import { NotificationEvent } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { EmailProvider } from "../providers/EmailProvider";

// HLD §7: "All sends are logged in NotificationLog (event type, recipient,
// related record, timestamp, status) so delivery can be verified if a
// resource reports not receiving an email." A failed send is logged, not
// thrown — the triggering action (e.g. the generation job) must not crash
// because an email failed to send.
export async function notify(
  emailProvider: EmailProvider,
  eventType: NotificationEvent,
  recipientEmail: string,
  relatedType: "invoice" | "document" | "resource",
  relatedId: string
): Promise<void> {
  try {
    await emailProvider.send(recipientEmail, eventType, relatedId);
    await prisma.notificationLog.create({
      data: { eventType, recipientEmail, relatedType, relatedId, status: "SENT" },
    });
  } catch (err) {
    await prisma.notificationLog.create({
      data: {
        eventType,
        recipientEmail,
        relatedType,
        relatedId,
        status: "FAILED",
        errorMessage: err instanceof Error ? err.message : String(err),
      },
    });
  }
}

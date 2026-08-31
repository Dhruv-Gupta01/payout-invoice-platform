import { prisma } from "../lib/prisma";
import { EmailProvider } from "../providers/EmailProvider";
import { JobQueue } from "../queue/JobQueue";
import { notify } from "../notifications/notifier";
import { autoClearReadyFlags } from "./invoiceGenerationService";

// LLD §2.7 / HLD §5.4: "Verify or Reject (+ reason) → status updated,
// reviewer + timestamp logged." HLD §7: resource is notified either way.
// Also re-checks this resource's FLAGGED invoices (user-requested — verifying
// the last outstanding document used to leave a ready invoice stuck FLAGGED
// until someone clicked acknowledge-flag by hand; see autoClearReadyFlags).
export async function verifyDocument(
  documentId: string,
  adminId: string,
  emailProvider: EmailProvider,
  jobQueue: JobQueue
) {
  const document = await prisma.document.update({
    where: { id: documentId },
    data: { status: "VERIFIED", reviewedById: adminId, reviewedAt: new Date() },
    include: { resource: true },
  });

  await notify(emailProvider, "DOCUMENT_VERIFIED", document.resource.email, "document", document.id);
  await autoClearReadyFlags(document.resourceId, jobQueue);

  return { id: document.id, status: document.status, reviewedAt: document.reviewedAt };
}

export async function rejectDocument(
  documentId: string,
  adminId: string,
  reason: string,
  emailProvider: EmailProvider
) {
  const document = await prisma.document.update({
    where: { id: documentId },
    data: { status: "REJECTED", rejectionReason: reason, reviewedById: adminId, reviewedAt: new Date() },
    include: { resource: true },
  });

  await notify(emailProvider, "DOCUMENT_REJECTED", document.resource.email, "document", document.id);

  return {
    id: document.id,
    status: document.status,
    reviewedAt: document.reviewedAt,
    rejectionReason: document.rejectionReason,
  };
}

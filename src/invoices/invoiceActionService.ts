import { prisma } from "../lib/prisma";
import { EmailProvider } from "../providers/EmailProvider";
import { notify } from "../notifications/notifier";

export class NotYourInvoiceError extends Error {}
export class AmountNotConfirmedError extends Error {}

// LLD §0.9 / §2.4 — gate 1
// POST /resource/invoices/:invoiceId/confirm-amount
// Response 200: { invoiceId, amountConfirmationStatus: "CONFIRMED" }
// Response 403: { error: "Not your invoice" }
export async function confirmAmount(invoiceId: string, resourceId: string) {
  const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
  if (invoice.resourceId !== resourceId) {
    throw new NotYourInvoiceError();
  }

  const updated = await prisma.invoice.update({
    where: { id: invoiceId },
    data: { amountConfirmationStatus: "CONFIRMED", amountConfirmedAt: new Date() },
  });

  return { invoiceId: updated.id, amountConfirmationStatus: updated.amountConfirmationStatus };
}

// LLD §0.9 / §2.4 — gate 1
// POST /resource/invoices/:invoiceId/reject-amount
// Request: { reason?: string }
// Response 200: { invoiceId, amountConfirmationStatus: "REJECTED" }
// Response 403: { error: "Not your invoice" }
// Fires AMOUNT_REJECTED to admin (ADMIN_NOTIFICATION_EMAIL, same pattern as INVOICE_DECLINED).
export async function rejectAmount(
  invoiceId: string,
  resourceId: string,
  reason: string | undefined,
  emailProvider: EmailProvider
) {
  const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
  if (invoice.resourceId !== resourceId) {
    throw new NotYourInvoiceError();
  }

  const updated = await prisma.invoice.update({
    where: { id: invoiceId },
    data: {
      amountConfirmationStatus: "REJECTED",
      amountConfirmedAt: new Date(),
      amountRejectionReason: reason ?? null,
    },
  });

  const adminEmail = process.env.ADMIN_NOTIFICATION_EMAIL;
  if (adminEmail) {
    await notify(emailProvider, "AMOUNT_REJECTED", adminEmail, "invoice", invoiceId);
  }

  return { invoiceId: updated.id, amountConfirmationStatus: updated.amountConfirmationStatus };
}

// LLD §2.4 — gate 2, only actionable once gate 1 has passed (§0.9)
// POST /resource/invoices/:invoiceId/approve
// Response 200: { invoiceId, approvalStatus: "APPROVED", actionedAt }
// Response 403: { error: "Not your invoice" }
// Response 403: { error: "Confirm your payout amount first" }
export async function approveInvoice(invoiceId: string, resourceId: string) {
  const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
  if (invoice.resourceId !== resourceId) {
    throw new NotYourInvoiceError();
  }
  if (invoice.amountConfirmationStatus !== "CONFIRMED") {
    throw new AmountNotConfirmedError();
  }

  const updated = await prisma.invoice.update({
    where: { id: invoiceId },
    data: { approvalStatus: "APPROVED", actionedAt: new Date() },
  });

  return { invoiceId: updated.id, approvalStatus: updated.approvalStatus, actionedAt: updated.actionedAt };
}

// LLD §2.4 — gate 2, only actionable once gate 1 has passed (§0.9)
// POST /resource/invoices/:invoiceId/decline
// Request: { reason?: string }
// Response 200: { invoiceId, approvalStatus: "DECLINED", actionedAt }
// Response 403: { error: "Not your invoice" }
// Response 403: { error: "Confirm your payout amount first" }
// HLD §5.6 / §7: admin notified. LLD §0.7: recipient is ADMIN_NOTIFICATION_EMAIL.
export async function declineInvoice(
  invoiceId: string,
  resourceId: string,
  reason: string | undefined,
  emailProvider: EmailProvider
) {
  const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
  if (invoice.resourceId !== resourceId) {
    throw new NotYourInvoiceError();
  }
  if (invoice.amountConfirmationStatus !== "CONFIRMED") {
    throw new AmountNotConfirmedError();
  }

  const updated = await prisma.invoice.update({
    where: { id: invoiceId },
    data: { approvalStatus: "DECLINED", actionedAt: new Date(), declineReason: reason ?? null },
  });

  const adminEmail = process.env.ADMIN_NOTIFICATION_EMAIL;
  if (adminEmail) {
    await notify(emailProvider, "INVOICE_DECLINED", adminEmail, "invoice", invoiceId);
  }

  return { invoiceId: updated.id, approvalStatus: updated.approvalStatus, actionedAt: updated.actionedAt };
}

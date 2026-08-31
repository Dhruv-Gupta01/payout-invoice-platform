import { NotificationEvent } from "@prisma/client";

// HLD §7 (Notifications table) — subject/body copy was never specified in
// the LLD/HLD. This is draft content for review, not final without a look —
// flagged when this file was added (Phase 8).
//
// `ref` is a human-readable reference (invoice number, document type name,
// or resource name) — RealEmailProvider looks this up so emails never show
// a raw database id. `reason` is only used by the two events that carry an
// optional one (DOCUMENT_REJECTED, AMOUNT_REJECTED).

// LLD §0.25: INVITE_SENT needs a clickable link embedded in the body, not
// just a human-readable ref — a structurally different kind of content than
// every other event, so it's a dedicated parameter rather than overloading
// `ref` or `reason`.
export function buildEmailContent(
  event: NotificationEvent,
  ref: string,
  reason?: string | null,
  inviteUrl?: string
): { subject: string; html: string } {
  switch (event) {
    case "PAYOUT_GENERATED":
      return {
        subject: `Your payout is ready to review (${ref})`,
        html: `<p>Your payout for <strong>${ref}</strong> has been calculated and is ready for you to review.</p><p>Please log in to the platform to confirm the amount.</p>`,
      };

    case "DOCUMENT_VERIFIED":
      return {
        subject: `Your ${ref} document has been verified`,
        html: `<p>Your <strong>${ref}</strong> document has been reviewed and verified. No further action is needed.</p>`,
      };

    case "DOCUMENT_REJECTED":
      return {
        subject: `Action needed: your ${ref} document was rejected`,
        html: `<p>Your <strong>${ref}</strong> document could not be verified${
          reason ? `: <strong>${reason}</strong>` : "."
        }</p><p>Please log in and re-upload a corrected copy.</p>`,
      };

    case "BANK_UNLOCKED":
      return {
        subject: "Your bank details have been unlocked",
        html: `<p>An admin has unlocked your bank details for editing, ${ref}.</p><p>Please log in and update them — they'll lock again automatically once you save.</p>`,
      };

    case "INVOICE_DECLINED":
      return {
        subject: `Invoice declined: ${ref}`,
        html: `<p>The resource has declined invoice <strong>${ref}</strong>.</p><p>Please review it on the admin dashboard.</p>`,
      };

    case "DOCUMENT_REUPLOADED":
      return {
        subject: `Document re-uploaded for review: ${ref}`,
        html: `<p>A resource has re-uploaded their <strong>${ref}</strong> document after a previous rejection.</p><p>Please review it on the admin dashboard.</p>`,
      };

    case "AMOUNT_REJECTED":
      return {
        subject: `Payout amount rejected: ${ref}`,
        html: `<p>The resource has rejected the computed payout amount for <strong>${ref}</strong>${
          reason ? `: <strong>${reason}</strong>` : "."
        }</p><p>Please correct the underlying data and reprocess it on the admin dashboard.</p>`,
      };

    case "INVITE_SENT":
      return {
        subject: "You're invited to the Payouts Console",
        html: `<p>Hi ${ref},</p><p>You've been invited to set up your account on the Payouts Console.</p><p><a href="${inviteUrl}">Click here to set your password</a> and get started. This link expires in 7 days.</p>`,
      };

    case "INVOICE_NOT_PAID":
      return {
        subject: `Invoiced but not paid: ${ref}`,
        html: `<p>Invoice <strong>${ref}</strong> is approved and generated but wasn't found in the most recent reconciliation file.</p><p>Please confirm whether payment has actually gone out.</p>`,
      };

    case "INVOICE_REOPENED":
      return {
        subject: `Your invoice is ready to review again (${ref})`,
        html: `<p>Your invoice <strong>${ref}</strong> has been reopened for your review.</p><p>Please log in to the platform to take another look.</p>`,
      };
  }
}

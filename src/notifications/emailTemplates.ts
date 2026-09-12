import { NotificationEvent } from "@prisma/client";

// HLD §7 (Notifications table) — subject/body copy was never specified in
// the LLD/HLD. Wording below is draft content for review, not final without
// a look — flagged when this file was first added (Phase 8). What *has*
// changed since then (user-requested): every event now renders through a
// shared branded wrapper instead of a bare `<p>...</p>` string, and ships a
// plain-text alternative alongside the HTML (better deliverability — a
// multipart email with a text part is less likely to be treated as spam
// than HTML-only, and some clients/screen readers prefer it outright).
//
// `ref` is a human-readable reference (invoice number, document type name,
// or resource name) — RealEmailProvider looks this up so emails never show
// a raw database id. `reason` is only used by the two events that carry an
// optional one (DOCUMENT_REJECTED, AMOUNT_REJECTED). All dynamic values are
// HTML-escaped before going into the template — `actorLabel` in particular
// is a resource's own name/email, i.e. attacker-controlled input as far as
// this email is concerned.

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Bold a piece of already-dynamic text, escaping it first.
function b(value: string): string {
  return `<strong>${escapeHtml(value)}</strong>`;
}

interface Cta {
  label: string;
  url: string;
}

const BRAND_LINE = "Biz Tech Analytics &middot; Payouts Console";
const FOOTER_TEXT = "This is an automated message from the Payouts Console. Please don't reply directly to this email.";

// Every event's body is just a list of already-HTML-safe paragraph strings
// (built with `b()` for any interpolated part) plus an optional single call
// to action — kept to one link/button per email on purpose. Rendered once
// here into both the HTML and the plain-text alternative, so the two can
// never drift out of sync with each other.
function renderEmail(subject: string, paragraphs: string[], cta?: Cta): { subject: string; html: string; text: string } {
  const paragraphHtml = paragraphs
    .map((p) => `<p style="margin:0 0 16px;color:#2b2b2b;font-size:14px;line-height:1.6;">${p}</p>`)
    .join("");
  const ctaHtml = cta
    ? `<p style="margin:24px 0 0;"><a href="${escapeHtml(cta.url)}" style="display:inline-block;background-color:#1f6f4a;color:#ffffff;text-decoration:none;font-size:13px;font-weight:600;padding:10px 22px;border-radius:6px;">${escapeHtml(cta.label)}</a></p>`
    : "";

  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:0;background-color:#f4f4f2;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background-color:#ffffff;border-radius:8px;border:1px solid #e3e3e0;">
            <tr>
              <td style="padding:22px 28px 16px;border-bottom:1px solid #ececea;">
                <p style="margin:0;font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#8a8a86;">${BRAND_LINE}</p>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 28px 8px;">
                ${paragraphHtml}${ctaHtml}
              </td>
            </tr>
            <tr>
              <td style="padding:16px 28px 24px;border-top:1px solid #ececea;">
                <p style="margin:0;font-size:12px;color:#9a9a96;">${FOOTER_TEXT}</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const stripTags = (s: string) => s.replace(/<[^>]+>/g, "");
  const textLines = ["Biz Tech Analytics — Payouts Console", "", ...paragraphs.map(stripTags)];
  if (cta) textLines.push("", `${cta.label}: ${cta.url}`);
  textLines.push("", FOOTER_TEXT);

  return { subject, html, text: textLines.join("\n") };
}

// LLD §0.25: INVITE_SENT needs a clickable link embedded in the body, not
// just a human-readable ref — a structurally different kind of content than
// every other event, so it's a dedicated parameter rather than overloading
// `ref` or `reason`.
export function buildEmailContent(
  event: NotificationEvent,
  ref: string,
  reason?: string | null,
  inviteUrl?: string,
  // "Name <email>" of the resource an admin-facing event is about. Falls
  // back to "The resource" when not supplied (e.g. in the pure-function tests).
  actorLabel?: string,
  // The frontend's own base URL — used to build a one-click CTA on every
  // event that has an obvious next screen. Omitted -> no CTA button, just
  // the paragraph text (still makes sense standalone).
  appUrl?: string
): { subject: string; html: string; text: string } {
  const actor = actorLabel ?? "The resource";
  const cta = (path: string, label: string): Cta | undefined => (appUrl ? { label, url: `${appUrl}${path}` } : undefined);

  switch (event) {
    case "PAYOUT_GENERATED":
      return renderEmail(
        `Your payout is ready to review (${ref})`,
        [`Your payout for ${b(ref)} has been calculated and is ready for you to review.`],
        cta("/invoices", "Review your payout")
      );

    case "DOCUMENT_VERIFIED":
      return renderEmail(`Your ${ref} document has been verified`, [
        `Your ${b(ref)} document has been reviewed and verified. No further action is needed.`,
      ]);

    case "DOCUMENT_REJECTED":
      return renderEmail(
        `Action needed: your ${ref} document was rejected`,
        [
          `Your ${b(ref)} document could not be verified${reason ? `: ${b(reason)}` : "."}`,
          "Please re-upload a corrected copy.",
        ],
        cta("/documents", "Re-upload your document")
      );

    case "BANK_UNLOCKED":
      return renderEmail(
        "Your bank details have been unlocked",
        [`An admin has unlocked your bank details for editing, ${escapeHtml(ref)}.`, "They'll lock again automatically once you save."],
        cta("/profile", "Update your bank details")
      );

    case "INVOICE_DECLINED":
      return renderEmail(
        `Invoice declined: ${ref}`,
        [`${b(actor)} has declined invoice ${b(ref)}.`],
        cta("/", "Open the admin dashboard")
      );

    case "DOCUMENT_REUPLOADED":
      return renderEmail(
        `Document re-uploaded for review: ${ref}`,
        [`${b(actor)} has re-uploaded their ${b(ref)} document after a previous rejection.`],
        cta("/", "Open the admin dashboard")
      );

    case "AMOUNT_REJECTED":
      return renderEmail(
        `Payout amount rejected: ${ref}`,
        [
          `${b(actor)} has rejected the computed payout amount for ${b(ref)}${reason ? `: ${b(reason)}` : "."}`,
          "Correct the underlying data (fix the Google Sheet and re-sync), then reprocess the invoice.",
        ],
        cta("/", "Open the admin dashboard")
      );

    case "INVITE_SENT":
      return renderEmail(
        "You're invited to the Payouts Console",
        [`Hi ${escapeHtml(ref)},`, "You've been invited to set up your account on the Payouts Console. This link expires in 7 days."],
        inviteUrl ? { label: "Set your password", url: inviteUrl } : undefined
      );

    case "INVOICE_NOT_PAID":
      return renderEmail(
        `Invoiced but not paid: ${ref}`,
        [`Invoice ${b(ref)} (${escapeHtml(actor)}) is approved and generated but wasn't found in the most recent reconciliation file.`],
        cta("/", "Open the admin dashboard")
      );

    case "INVOICE_REOPENED":
      return renderEmail(
        `Your invoice is ready to review again (${ref})`,
        [`Your invoice ${b(ref)} has been reopened for your review.`],
        cta("/invoices", "Review your invoice")
      );
  }
}

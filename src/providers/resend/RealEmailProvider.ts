import { Resend } from "resend";
import { NotificationEvent } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { EmailProvider } from "../EmailProvider";
import { buildEmailContent } from "../../notifications/emailTemplates";

// Which relatedType each event implies — not carried on EmailProvider.send's
// signature (only eventType + relatedId), but consistent per event at every
// notify() call site in the codebase.
const INVOICE_EVENTS: NotificationEvent[] = [
  "PAYOUT_GENERATED",
  "INVOICE_DECLINED",
  "AMOUNT_REJECTED",
  "INVOICE_NOT_PAID",
  "INVOICE_REOPENED",
];
const DOCUMENT_EVENTS: NotificationEvent[] = ["DOCUMENT_VERIFIED", "DOCUMENT_REJECTED", "DOCUMENT_REUPLOADED"];

const DOC_TYPE_LABELS: Record<string, string> = {
  AADHAAR: "Aadhaar",
  PAN: "PAN",
  PHOTO: "Photo",
  BANK_PROOF: "Bank Proof",
  NDA: "NDA",
  ICA: "ICA",
};

// LLD §0.25 — the frontend's own public base URL. Backend-only env var
// (never sent to the client), needed to build a clickable accept-invite
// link. Defaults to the local dev frontend; must be set for real in
// production.
const FRONTEND_BASE_URL = process.env.FRONTEND_BASE_URL ?? "http://localhost:4000";

// "Name <email>" for the resource an event is about — shown in the
// admin-facing emails (AMOUNT_REJECTED, INVOICE_DECLINED, DOCUMENT_REUPLOADED,
// INVOICE_NOT_PAID) so the admin knows *who* acted without opening the app.
function actorLabelOf(resource: { name: string; email: string } | null | undefined): string | undefined {
  return resource ? `${resource.name} <${resource.email}>` : undefined;
}

async function resolveRefAndReason(
  eventType: NotificationEvent,
  relatedId: string
): Promise<{ ref: string; reason?: string | null; inviteUrl?: string; actorLabel?: string }> {
  if (INVOICE_EVENTS.includes(eventType)) {
    const invoice = await prisma.invoice.findUnique({
      where: { id: relatedId },
      include: { resource: true },
    });
    return {
      ref: invoice?.invoiceNo ?? relatedId,
      reason: eventType === "AMOUNT_REJECTED" ? invoice?.amountRejectionReason : undefined,
      actorLabel: actorLabelOf(invoice?.resource),
    };
  }
  if (DOCUMENT_EVENTS.includes(eventType)) {
    const document = await prisma.document.findUnique({
      where: { id: relatedId },
      include: { resource: true },
    });
    return {
      ref: document ? (DOC_TYPE_LABELS[document.docType] ?? document.docType) : relatedId,
      reason: eventType === "DOCUMENT_REJECTED" ? document?.rejectionReason : undefined,
      actorLabel: actorLabelOf(document?.resource),
    };
  }
  if (eventType === "INVITE_SENT") {
    // relatedId is a Resource id — the invite token was just set on it by
    // sendInvite (LLD §0.25), so it's still there to build the link from.
    const resource = await prisma.resource.findUnique({ where: { id: relatedId } });
    const inviteUrl = resource?.inviteToken
      ? `${FRONTEND_BASE_URL}/accept-invite?token=${resource.inviteToken}`
      : undefined;
    return { ref: resource?.name ?? relatedId, inviteUrl };
  }
  // BANK_UNLOCKED — relatedId is a Resource id.
  const resource = await prisma.resource.findUnique({ where: { id: relatedId } });
  return { ref: resource?.name ?? relatedId };
}

export class RealEmailProvider implements EmailProvider {
  private resend: Resend;
  private fromEmail: string;

  constructor() {
    const apiKey = process.env.RESEND_API_KEY;
    const fromEmail = process.env.RESEND_FROM_EMAIL;
    if (!apiKey || !fromEmail) {
      throw new Error("RESEND_API_KEY and RESEND_FROM_EMAIL must both be set to use RealEmailProvider.");
    }
    this.resend = new Resend(apiKey);
    this.fromEmail = fromEmail;
  }

  async send(to: string, eventType: NotificationEvent, relatedId: string): Promise<void> {
    const { ref, reason, inviteUrl, actorLabel } = await resolveRefAndReason(eventType, relatedId);
    const { subject, html } = buildEmailContent(eventType, ref, reason, inviteUrl, actorLabel);

    const result = await this.resend.emails.send({ from: this.fromEmail, to, subject, html });
    if (result.error) {
      throw new Error(`Resend send failed: ${result.error.message}`);
    }
  }
}

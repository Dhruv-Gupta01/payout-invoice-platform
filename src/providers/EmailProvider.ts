import { NotificationEvent } from "@prisma/client";

// Behind-an-interface boundary for the Resend integration (HLD §7, LLD §2/§5).
// Real implementation lands in Phase 8; tests use FakeEmailProvider — no real
// emails sent in tests. Email content (subject/body copy) isn't specified
// anywhere in the LLD/HLD, so it's not modeled here either — that's Phase 8
// scope, decided alongside the real Resend integration.
export interface EmailProvider {
  send(to: string, eventType: NotificationEvent, relatedId: string): Promise<void>;
}

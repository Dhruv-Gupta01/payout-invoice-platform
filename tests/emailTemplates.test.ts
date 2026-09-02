import { describe, it, expect } from "vitest";
import { buildEmailContent } from "../src/notifications/emailTemplates";

// Traces to HLD §7 (Notifications table) — subject/body copy was never
// specified anywhere in the LLD/HLD (flagged since Phase 4's EmailProvider
// was built). Draft copy for your review, not final without a look.
// Pure function — no Resend call — testable directly.

describe("buildEmailContent", () => {
  it("drafts content for all seven events, each mentioning the reference and staying non-empty", () => {
    const events: [string, string][] = [
      ["PAYOUT_GENERATED", "INV-0001"],
      ["DOCUMENT_VERIFIED", "PAN"],
      ["DOCUMENT_REJECTED", "AADHAAR"],
      ["BANK_UNLOCKED", "Jane Doe"],
      ["INVOICE_DECLINED", "INV-0002"],
      ["DOCUMENT_REUPLOADED", "BANK_PROOF"],
      ["AMOUNT_REJECTED", "INV-0003"],
    ];

    for (const [event, ref] of events) {
      const content = buildEmailContent(event as never, ref);
      expect(content.subject.length).toBeGreaterThan(0);
      expect(content.html).toContain(ref);
    }
  });

  it("includes an optional reason in DOCUMENT_REJECTED and AMOUNT_REJECTED content when given", () => {
    const rejected = buildEmailContent("DOCUMENT_REJECTED" as never, "AADHAAR", "Photo is blurry");
    expect(rejected.html).toContain("Photo is blurry");

    const amountRejected = buildEmailContent("AMOUNT_REJECTED" as never, "INV-0003", "Hours look wrong");
    expect(amountRejected.html).toContain("Hours look wrong");
  });

  it("names the acting resource in admin-facing events when actorLabel is supplied, falling back otherwise", () => {
    const label = "Ritika Garg <ritika@example.com>";
    for (const event of ["AMOUNT_REJECTED", "INVOICE_DECLINED", "DOCUMENT_REUPLOADED", "INVOICE_NOT_PAID"]) {
      const withActor = buildEmailContent(event as never, "INV-0009", null, undefined, label);
      expect(withActor.html).toContain(label);

      const withoutActor = buildEmailContent(event as never, "INV-0009");
      expect(withoutActor.html).toContain("The resource");
    }
  });
});

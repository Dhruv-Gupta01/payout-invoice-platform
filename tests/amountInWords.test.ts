import { describe, it, expect } from "vitest";
import { amountToWords } from "../src/invoices/amountInWords";

// Traces to LLD §4 ({{AMOUNT_IN_WORDS}} placeholder) — no conversion method
// was ever specified (flagged since Phase 3); this is that decision,
// implemented via `to-words` with Indian lakh/crore grouping (matches the
// PAN/IFSC/Aadhaar context — this is an Indian payroll system).
// Pure function, no external API — testable directly, unlike the real
// Google/Resend providers.

describe("amountToWords", () => {
  it("converts a whole-rupee amount to words with a Rupees prefix", () => {
    const words = amountToWords(1000);
    expect(words).toContain("Rupees");
    expect(words).toContain("One Thousand");
  });

  it("uses Indian lakh/crore grouping for large amounts, not western thousand/million", () => {
    const words = amountToWords(150000); // should read "One Lakh Fifty Thousand", not "One Hundred Fifty Thousand"
    expect(words).toContain("Lakh");
  });

  it("handles paise (decimal) amounts", () => {
    const words = amountToWords(1000.5);
    expect(words).toContain("Rupees");
    expect(words.toLowerCase()).toContain("paise");
  });
});

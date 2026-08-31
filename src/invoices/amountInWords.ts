import { ToWords } from "to-words";

// LLD §4 {{AMOUNT_IN_WORDS}} — no conversion method specified in the LLD
// (flagged since Phase 3). Uses `to-words` with en-IN locale for lakh/crore
// grouping, matching the Indian payroll context (PAN/IFSC/Aadhaar).
const toWords = new ToWords({
  localeCode: "en-IN",
  converterOptions: {
    currency: true,
    ignoreDecimal: false,
    ignoreZeroCurrency: false,
    doNotAddOnly: false,
  },
});

export function amountToWords(amount: number): string {
  return toWords.convert(amount);
}

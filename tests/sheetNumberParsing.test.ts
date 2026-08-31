import { describe, it, expect } from "vitest";
import { parseLeadingNumber, roundMoney } from "../src/providers/google/sheetNumberParsing";

// Traces to LLD §2.2 (sync) via the real-sheet discovery in Phase 8: the
// actual sheet's "Rate (INR)" column contains values like "100/hr" (a
// trailing unit, not a clean number) — a naive Number() parse would
// silently produce NaN → 0, corrupting real payout amounts. This is the
// fix, as a pure/tested function.

describe("parseLeadingNumber", () => {
  it("parses a clean integer", () => {
    expect(parseLeadingNumber("100")).toBe(100);
  });

  it("parses a decimal", () => {
    expect(parseLeadingNumber("34.3")).toBe(34.3);
  });

  it("parses a number with a trailing unit suffix, e.g. '100/hr'", () => {
    expect(parseLeadingNumber("100/hr")).toBe(100);
  });

  it("parses a number with commas as thousands separators", () => {
    expect(parseLeadingNumber("1,000")).toBe(1000);
  });

  it("returns 0 for blank or non-numeric input", () => {
    expect(parseLeadingNumber("")).toBe(0);
    expect(parseLeadingNumber(undefined)).toBe(0);
    expect(parseLeadingNumber("N/A")).toBe(0);
  });
});

// Real-sheet discovery (Phase 8): hours × rate on real values (e.g.
// 34.3 × 100) produces raw floating-point noise (3429.9999999999995,
// not 3430) — not something to store as a real payout amount.
describe("roundMoney", () => {
  it("rounds floating-point multiplication noise to 2 decimal places", () => {
    expect(roundMoney(34.3 * 100)).toBe(3430);
    expect(roundMoney(18.6 * 100)).toBe(1860);
    expect(roundMoney(17.1 * 100)).toBe(1710);
  });

  it("preserves genuine paise (2 decimal places)", () => {
    expect(roundMoney(1234.567)).toBe(1234.57);
  });
});

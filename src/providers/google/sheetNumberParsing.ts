// Real-sheet discovery (Phase 8): "Rate (INR)" contains values like
// "100/hr" — a trailing unit, not a clean number. Extracts the leading
// numeric token (with optional thousands commas) instead of a naive
// Number() parse, which would silently produce NaN → 0 and corrupt real
// payout amounts.
export function parseLeadingNumber(value: string | undefined): number {
  if (!value) return 0;
  const match = value.trim().match(/-?[\d,]+\.?\d*/);
  if (!match) return 0;
  const parsed = Number(match[0].replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

// Real-sheet discovery (Phase 8): hours × rate on real values produces raw
// floating-point noise (34.3 × 100 = 3429.9999999999995) — round to 2
// decimal places (paise) before it's stored as a payout amount.
export function roundMoney(amount: number): number {
  return Math.round(amount * 100) / 100;
}

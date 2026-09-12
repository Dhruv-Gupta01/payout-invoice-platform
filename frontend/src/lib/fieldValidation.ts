// Mirrors src/lib/fieldValidation.ts on the backend — same patterns, so a
// resource sees the same error here that the server would otherwise reject
// with. The backend is still the one that actually enforces this (a direct
// API call can't skip it); this file is just for immediate in-browser
// feedback. Not spec, user-requested.

const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const IFSC_PATTERN = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const ACCOUNT_NO_PATTERN = /^\d{9,18}$/;
const CONTACT_NO_PATTERN = /^(?:\+91|91|0)?[6-9]\d{9}$/;
const BENEFICIARY_NAME_PATTERN = /^[A-Za-z][A-Za-z .'-]*$/;

export function panError(value: string): string | null {
  return PAN_PATTERN.test(value.trim().toUpperCase()) ? null : "PAN must be in the format ABCDE1234F";
}

export function ifscError(value: string): string | null {
  return IFSC_PATTERN.test(value.trim().toUpperCase())
    ? null
    : "IFSC must be 4 letters, then 0, then 6 letters/digits (e.g. HDFC0001234)";
}

export function accountNoError(value: string): string | null {
  return ACCOUNT_NO_PATTERN.test(value.trim()) ? null : "Account number must be 9 to 18 digits";
}

export function contactNoError(value: string): string | null {
  return CONTACT_NO_PATTERN.test(value.trim()) ? null : "Enter a valid 10-digit Indian mobile number";
}

export function beneficiaryNameError(value: string): string | null {
  return BENEFICIARY_NAME_PATTERN.test(value.trim())
    ? null
    : "Beneficiary name can only contain letters, spaces, and . ' -";
}

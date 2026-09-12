// Format validation for the resource profile/bank fields (onboarding +
// profile edit) — not spec'd in the LLD/HLD, user-requested. Previously
// none of these fields had any format check at all, client or server —
// any string was accepted for PAN, IFSC, account number, contact number.
// Given the app's own warning banner tells resources a mismatched bank
// name/account means "the money is gone" (irreversible), catching an
// obviously-malformed value before it's saved is worth doing on both ends:
// the frontend mirrors these same patterns for immediate feedback, but
// only server-side validation actually blocks a direct API call.

export class FieldValidationError extends Error {
  constructor(
    public readonly field: string,
    message: string
  ) {
    super(message);
  }
}

// 5 letters, 4 digits, 1 letter — e.g. ABCPG1234K.
const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

// 4 letters, a literal 0, then 6 letters/digits — e.g. HDFC0001234.
const IFSC_PATTERN = /^[A-Z]{4}0[A-Z0-9]{6}$/;

// Indian bank account numbers vary by bank but are consistently 9-18
// digits — not a bank-specific check, just rules out obviously-wrong input.
const ACCOUNT_NO_PATTERN = /^\d{9,18}$/;

// 10-digit Indian mobile number, optional +91/91/0 prefix.
const CONTACT_NO_PATTERN = /^(?:\+91|91|0)?[6-9]\d{9}$/;

// Letters, spaces, and . ' - (no digits) — must match what the bank has on
// file, which is a person's name, never a number.
const BENEFICIARY_NAME_PATTERN = /^[A-Za-z][A-Za-z .'-]*$/;

function normalize(value: string): string {
  return value.trim();
}

export function isValidPan(value: string): boolean {
  return PAN_PATTERN.test(normalize(value).toUpperCase());
}

export function isValidIfsc(value: string): boolean {
  return IFSC_PATTERN.test(normalize(value).toUpperCase());
}

export function isValidAccountNo(value: string): boolean {
  return ACCOUNT_NO_PATTERN.test(normalize(value));
}

export function isValidContactNo(value: string): boolean {
  return CONTACT_NO_PATTERN.test(normalize(value));
}

export function isValidBeneficiaryName(value: string): boolean {
  return BENEFICIARY_NAME_PATTERN.test(normalize(value));
}

interface ProfileFields {
  address?: string;
  contactNo?: string;
  pan?: string;
  beneficiaryName?: string;
  accountNo?: string;
  bankName?: string;
  ifsc?: string;
}

// Validates whichever of these fields are present in `input` (string and
// non-empty already assumed by the caller for required-field checks —
// this only checks *format*). Used for both the full onboarding submission
// (every field present) and a partial profile edit (only changed fields
// present) — same per-field rules either way.
export function validateProfileFieldFormats(input: ProfileFields): void {
  if (input.pan !== undefined && !isValidPan(input.pan)) {
    throw new FieldValidationError("pan", "PAN must be in the format ABCDE1234F");
  }
  if (input.ifsc !== undefined && !isValidIfsc(input.ifsc)) {
    throw new FieldValidationError("ifsc", "IFSC code must be 4 letters, then 0, then 6 letters/digits (e.g. HDFC0001234)");
  }
  if (input.accountNo !== undefined && !isValidAccountNo(input.accountNo)) {
    throw new FieldValidationError("accountNo", "Account number must be 9 to 18 digits");
  }
  if (input.contactNo !== undefined && !isValidContactNo(input.contactNo)) {
    throw new FieldValidationError("contactNo", "Contact number must be a valid 10-digit Indian mobile number");
  }
  if (input.beneficiaryName !== undefined && !isValidBeneficiaryName(input.beneficiaryName)) {
    throw new FieldValidationError("beneficiaryName", "Beneficiary name can only contain letters, spaces, and . ' -");
  }
  if (input.address !== undefined && normalize(input.address).length === 0) {
    throw new FieldValidationError("address", "Address is required");
  }
}

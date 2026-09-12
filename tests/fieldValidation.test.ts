import { describe, it, expect } from "vitest";
import {
  isValidPan,
  isValidIfsc,
  isValidAccountNo,
  isValidContactNo,
  isValidBeneficiaryName,
  validateProfileFieldFormats,
  FieldValidationError,
} from "../src/lib/fieldValidation";

// Pure functions — no DB — testable directly. Not spec, user-requested:
// format validation on the onboarding/profile fields, previously accepted
// any string.

describe("isValidPan", () => {
  it("accepts a well-formed PAN", () => {
    expect(isValidPan("ABCPG1234K")).toBe(true);
    expect(isValidPan("abcpg1234k")).toBe(true); // case-insensitive
  });

  it("rejects a malformed PAN", () => {
    expect(isValidPan("ABCPG1234")).toBe(false); // 9 chars, missing trailing letter
    expect(isValidPan("12345ABCDE")).toBe(false); // wrong layout
    expect(isValidPan("")).toBe(false);
  });
});

describe("isValidIfsc", () => {
  it("accepts a well-formed IFSC code", () => {
    expect(isValidIfsc("HDFC0001234")).toBe(true);
    expect(isValidIfsc("sbin0001234")).toBe(true); // case-insensitive
  });

  it("rejects a malformed IFSC code", () => {
    expect(isValidIfsc("HDFC0001")).toBe(false); // too short
    expect(isValidIfsc("HDFC1001234")).toBe(false); // 5th char must be literal 0
  });
});

describe("isValidAccountNo", () => {
  it("accepts 9-18 digit account numbers", () => {
    expect(isValidAccountNo("111222333")).toBe(true); // 9 digits
    expect(isValidAccountNo("123456789012345678")).toBe(true); // 18 digits
  });

  it("rejects too short, too long, or non-numeric", () => {
    expect(isValidAccountNo("12345")).toBe(false);
    expect(isValidAccountNo("1234567890123456789")).toBe(false); // 19 digits
    expect(isValidAccountNo("1234-5678-90")).toBe(false);
  });
});

describe("isValidContactNo", () => {
  it("accepts a 10-digit Indian mobile number, with or without a prefix", () => {
    expect(isValidContactNo("9876543210")).toBe(true);
    expect(isValidContactNo("+919876543210")).toBe(true);
    expect(isValidContactNo("09876543210")).toBe(true);
  });

  it("rejects the wrong length or a number not starting 6-9", () => {
    expect(isValidContactNo("12345")).toBe(false);
    expect(isValidContactNo("1234567890")).toBe(false); // starts with 1
  });
});

describe("isValidBeneficiaryName", () => {
  it("accepts letters, spaces, and . ' -", () => {
    expect(isValidBeneficiaryName("Ritika Garg")).toBe(true);
    expect(isValidBeneficiaryName("O'Brien-Smith")).toBe(true);
  });

  it("rejects a name containing digits", () => {
    expect(isValidBeneficiaryName("Resource123")).toBe(false);
  });
});

describe("validateProfileFieldFormats", () => {
  it("throws a FieldValidationError naming the offending field", () => {
    expect(() => validateProfileFieldFormats({ pan: "not-a-pan" })).toThrow(FieldValidationError);
    try {
      validateProfileFieldFormats({ ifsc: "bad" });
    } catch (err) {
      expect(err).toBeInstanceOf(FieldValidationError);
      expect((err as FieldValidationError).field).toBe("ifsc");
    }
  });

  it("only validates fields that are present (partial updates)", () => {
    expect(() => validateProfileFieldFormats({ contactNo: "9876543210" })).not.toThrow();
    expect(() => validateProfileFieldFormats({})).not.toThrow();
  });

  it("rejects a blank address", () => {
    expect(() => validateProfileFieldFormats({ address: "   " })).toThrow(FieldValidationError);
  });
});

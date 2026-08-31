import { describe, it, expect } from "vitest";
import { buildPlaceholderRequests } from "../src/worker/placeholderRequests";

// Traces to LLD §4 — the exact 16 replaceAllText requests, matchCase: true.

describe("buildPlaceholderRequests", () => {
  it("builds all 16 LLD §4 placeholder requests from an invoice + resource + sheetRow", () => {
    const requests = buildPlaceholderRequests({
      invoice: {
        invoiceNo: "INV-0001",
        amount: 1000,
        invoiceDate: new Date("2026-08-24T00:00:00Z"),
      },
      resource: {
        name: "Ritika Garg",
        address: "123 Example St",
        contactNo: "9876543210",
        email: "ritika@example.com",
        pan: "ABCDE1234F",
        beneficiaryName: "Ritika Garg",
        accountNo: "1234567890",
        bankName: "Example Bank",
        ifsc: "EXAM0001234",
      },
      sheetRow: {
        projectName: "Project Alpha",
        hours: 10,
        rate: 100,
      },
    });

    expect(requests).toHaveLength(16);

    const findReplacement = (token: string) => {
      const req = requests.find(
        (r) => r.replaceAllText.containsText.text === `{{${token}}}`
      );
      return req?.replaceAllText.replaceText;
    };

    expect(findReplacement("RESOURCE_NAME")).toBe("Ritika Garg");
    expect(findReplacement("ADDRESS")).toBe("123 Example St");
    expect(findReplacement("CONTACT_NO")).toBe("9876543210");
    expect(findReplacement("EMAIL")).toBe("ritika@example.com");
    expect(findReplacement("PAN")).toBe("ABCDE1234F");
    expect(findReplacement("INVOICE_NO")).toBe("INV-0001");
    expect(findReplacement("INVOICE_DATE")).toBe("24 Aug 2026");
    expect(findReplacement("PROJECT_NAME")).toBe("Project Alpha");
    expect(findReplacement("HOURS")).toBe("10");
    expect(findReplacement("RATE")).toBe("100");
    expect(findReplacement("AMOUNT")).toBe("1000");
    expect(findReplacement("AMOUNT_IN_WORDS")).toContain("One Thousand");
    expect(findReplacement("BENEFICIARY_NAME")).toBe("Ritika Garg");
    expect(findReplacement("ACCOUNT_NO")).toBe("1234567890");
    expect(findReplacement("BANK_NAME")).toBe("Example Bank");
    expect(findReplacement("IFSC")).toBe("EXAM0001234");

    // All requests use matchCase: true (LLD §4)
    for (const req of requests) {
      expect(req.replaceAllText.containsText.matchCase).toBe(true);
    }
  });
});

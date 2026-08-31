import { amountToWords } from "../invoices/amountInWords";

// LLD §4 — Google Docs API template fill. Exact 16 replaceAllText requests,
// matchCase: true, in the order the LLD lists them.

interface PlaceholderInvoice {
  invoiceNo: string;
  amount: number;
  invoiceDate: Date;
}

interface PlaceholderResource {
  name: string;
  address: string | null;
  contactNo: string | null;
  email: string;
  pan: string | null;
  beneficiaryName: string | null;
  accountNo: string | null;
  bankName: string | null;
  ifsc: string | null;
}

interface PlaceholderSheetRow {
  projectName: string;
  hours: number;
  rate: number;
}

function formatInvoiceDate(date: Date): string {
  const day = date.getUTCDate();
  const month = date.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  const year = date.getUTCFullYear();
  return `${day} ${month} ${year}`;
}

function replaceAllText(token: string, value: string) {
  return {
    replaceAllText: {
      containsText: { text: `{{${token}}}`, matchCase: true },
      replaceText: value,
    },
  };
}

export function buildPlaceholderRequests(data: {
  invoice: PlaceholderInvoice;
  resource: PlaceholderResource;
  sheetRow: PlaceholderSheetRow;
}) {
  const { invoice, resource, sheetRow } = data;

  return [
    replaceAllText("RESOURCE_NAME", resource.name),
    replaceAllText("ADDRESS", resource.address ?? ""),
    replaceAllText("CONTACT_NO", resource.contactNo ?? ""),
    replaceAllText("EMAIL", resource.email),
    replaceAllText("PAN", resource.pan ?? ""),
    replaceAllText("INVOICE_NO", invoice.invoiceNo),
    replaceAllText("INVOICE_DATE", formatInvoiceDate(invoice.invoiceDate)),
    replaceAllText("PROJECT_NAME", sheetRow.projectName),
    replaceAllText("HOURS", String(sheetRow.hours)),
    replaceAllText("RATE", String(sheetRow.rate)),
    replaceAllText("AMOUNT", String(invoice.amount)),
    replaceAllText("AMOUNT_IN_WORDS", amountToWords(invoice.amount)),
    replaceAllText("BENEFICIARY_NAME", resource.beneficiaryName ?? ""),
    replaceAllText("ACCOUNT_NO", resource.accountNo ?? ""),
    replaceAllText("BANK_NAME", resource.bankName ?? ""),
    replaceAllText("IFSC", resource.ifsc ?? ""),
  ];
}

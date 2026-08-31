import { google } from "googleapis";
import { Auth } from "googleapis";
import { RawSheetRow, SheetsProvider } from "../SheetsProvider";
import { parseLeadingNumber, roundMoney } from "./sheetNumberParsing";

// LLD §2.2 / HLD §5.1. The LLD never specifies the sheet's actual column
// layout, so this reads the header row and matches columns by name instead
// of assuming a fixed position. Aliases below were originally a guess;
// "hour" and "rateinr" were added after checking against the real sheet
// (Phase 8) — the real headers are "Hour " (singular) and "Rate (INR)",
// neither of which the original guesses ("hours", "rate") matched.
function normalize(header: string): string {
  return header.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

type MappedField = "resourceEmail" | "resourceName" | "month" | "projectName" | "batch" | "role" | "hours" | "rate" | "sheetAmount";

const ALIASES: Record<MappedField, string[]> = {
  resourceEmail: ["email", "resourceemail", "emailaddress"],
  resourceName: ["name", "resourcename"],
  month: ["month"],
  projectName: ["project", "projectname"],
  batch: ["batch"],
  role: ["role"],
  hours: ["hours", "hour"],
  rate: ["rate", "rateinr"],
  // The sheet's "Amount" column is the optional override (LLD §1 comment:
  // "sheetAmount ... used as an override if filled") — computedAmount is
  // always derived from hours × rate below, never read off the sheet
  // directly, since the real sheet leaves Amount blank for un-overridden
  // rows (confirmed against the real sheet, Phase 8).
  sheetAmount: ["amount", "sheetamount", "overrideamount", "finalamount", "manualamount"],
};

function buildColumnMap(headerRow: string[]): Partial<Record<MappedField, number>> {
  const normalizedHeaders = headerRow.map(normalize);
  const map: Partial<Record<MappedField, number>> = {};
  for (const [field, aliases] of Object.entries(ALIASES) as [MappedField, string[]][]) {
    const index = normalizedHeaders.findIndex((h) => aliases.includes(h));
    if (index !== -1) {
      map[field] = index;
    }
  }
  return map;
}

export class RealSheetsProvider implements SheetsProvider {
  private sheets: ReturnType<typeof google.sheets>;
  private spreadsheetId: string;

  constructor(auth: Auth.JWT) {
    this.sheets = google.sheets({ version: "v4", auth });
    const spreadsheetId = process.env.GOOGLE_SHEET_ID;
    if (!spreadsheetId) {
      throw new Error("GOOGLE_SHEET_ID must be set to use RealSheetsProvider.");
    }
    this.spreadsheetId = spreadsheetId;
  }

  async fetchRows(): Promise<RawSheetRow[]> {
    const res = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: "A:Z",
    });
    const rows = res.data.values ?? [];
    if (rows.length === 0) {
      return [];
    }

    const [headerRow, ...dataRows] = rows;
    const columnMap = buildColumnMap(headerRow as string[]);

    return dataRows.map((row, i) => {
      const get = (field: MappedField): string | undefined => {
        const index = columnMap[field];
        return index !== undefined ? (row[index] as string | undefined) : undefined;
      };

      const hours = parseLeadingNumber(get("hours"));
      const rate = parseLeadingNumber(get("rate"));
      const sheetAmountRaw = get("sheetAmount");

      return {
        rowIndex: i + 2, // +1 for 0-index, +1 for the header row
        resourceEmail: get("resourceEmail") ?? "",
        resourceName: get("resourceName") ?? "",
        month: get("month") ?? "",
        projectName: get("projectName") ?? "",
        batch: get("batch") ?? "",
        role: get("role") ?? "",
        hours,
        rate,
        computedAmount: roundMoney(hours * rate),
        sheetAmount: sheetAmountRaw ? roundMoney(parseLeadingNumber(sheetAmountRaw)) : undefined,
        rawData: Object.fromEntries((headerRow as string[]).map((h, idx) => [h, row[idx] ?? null])),
      };
    });
  }
}

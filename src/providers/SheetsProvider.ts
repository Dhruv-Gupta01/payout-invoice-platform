// Behind-an-interface boundary for the Google Sheets integration (HLD §5.1,
// LLD §2.2). Real implementation (Google Sheets API) lands in Phase 8; tests
// use FakeSheetsProvider exclusively — no real external calls in tests.

export interface RawSheetRow {
  rowIndex: number; // 1-based position in the sheet, used only to identify unmatched rows in `skipped`
  resourceEmail: string;
  resourceName: string;
  month: string;
  projectName: string;
  batch: string;
  role: string;
  hours: number;
  rate: number;
  computedAmount: number;
  sheetAmount?: number;
  rawData: Record<string, unknown>;
}

export interface SheetsProvider {
  fetchRows(): Promise<RawSheetRow[]>;
}

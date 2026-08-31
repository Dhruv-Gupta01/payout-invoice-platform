import { RawSheetRow, SheetsProvider } from "../SheetsProvider";

// In-memory fake for tests (and for local dev until Phase 8 wires in the
// real Google Sheets client). `setRows` lets a test set up exactly the
// sheet snapshot it needs for a given sync call.
export class FakeSheetsProvider implements SheetsProvider {
  private rows: RawSheetRow[] = [];

  setRows(rows: RawSheetRow[]): void {
    this.rows = rows;
  }

  async fetchRows(): Promise<RawSheetRow[]> {
    return this.rows;
  }
}

// Behind-an-interface boundary for the Google Drive integration (LLD §5,
// and KYC document storage per HLD §9: "stored in a restricted Drive folder
// structure"). Real implementation lands in Phase 8; tests use
// FakeDriveProvider — no real Drive calls in tests.
export interface DriveProvider {
  copyTemplate(templateId: string, targetFolderId: string): Promise<string>; // returns the new file's id
  shareWithEmail(fileId: string, email: string): Promise<void>;
  uploadFile(fileName: string, content: Buffer): Promise<string>; // returns the file's URL
  // Added per LLD §0.24 — reprocessInvoice/regenerate-document delete the old
  // Drive file when re-filling with corrected/updated data, since its
  // {{TOKENS}} are already consumed and can't be refilled in place.
  deleteFile(fileId: string): Promise<void>;
}

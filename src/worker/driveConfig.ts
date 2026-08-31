// Extracted from invoiceWorker.ts per LLD §0.24 — shared with
// invoiceGenerationService.ts's regenerate-document action, which also
// needs to copy a fresh template and build the resulting doc URL.
export const TEMPLATE_ID = process.env.GOOGLE_INVOICE_TEMPLATE_ID ?? "";
export const TARGET_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID ?? "";

export function buildDriveUrl(fileId: string): string {
  return `https://docs.google.com/document/d/${fileId}/edit`;
}

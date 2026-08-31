// Behind-an-interface boundary for the Google Docs integration (LLD §4-5).
// Real implementation lands in Phase 8; tests use FakeDocsProvider.
export interface DocsProvider {
  batchUpdate(fileId: string, requests: unknown[]): Promise<void>;
}

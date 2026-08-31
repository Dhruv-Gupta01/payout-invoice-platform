import { DocsProvider } from "../DocsProvider";

export class FakeDocsProvider implements DocsProvider {
  public calls: { fileId: string; requests: unknown[] }[] = [];
  private failuresRemaining = 0;

  // Makes the next `n` calls to batchUpdate throw, then succeed as normal —
  // lets a test simulate a transient Docs API failure.
  failNextCalls(n: number): void {
    this.failuresRemaining = n;
  }

  async batchUpdate(fileId: string, requests: unknown[]): Promise<void> {
    this.calls.push({ fileId, requests });
    if (this.failuresRemaining > 0) {
      this.failuresRemaining--;
      throw new Error("Simulated Docs API failure");
    }
  }
}

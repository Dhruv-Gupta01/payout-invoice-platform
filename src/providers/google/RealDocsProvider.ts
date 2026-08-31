import { google } from "googleapis";
import { Auth } from "googleapis";
import { DocsProvider } from "../DocsProvider";

// LLD §4 — batchUpdate is naturally idempotent (a retry that re-runs after
// a partial failure finds no matching token for placeholders already
// replaced, no-op, fills whatever's left).
//
// `auth` should be the SAME client used for RealDriveProvider's copy step
// (LLD §0.18) — on a personal account, a file created via OAuth isn't
// automatically visible to the service account, so filling it needs to
// happen as the same identity that created it.
export class RealDocsProvider implements DocsProvider {
  private docs: ReturnType<typeof google.docs>;

  constructor(auth: Auth.JWT | Auth.OAuth2Client) {
    this.docs = google.docs({ version: "v1", auth });
  }

  async batchUpdate(fileId: string, requests: unknown[]): Promise<void> {
    await this.docs.documents.batchUpdate({
      documentId: fileId,
      requestBody: { requests: requests as never[] },
    });
  }
}

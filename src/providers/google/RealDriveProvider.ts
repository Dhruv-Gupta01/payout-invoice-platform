import { google } from "googleapis";
import { Readable } from "stream";
import { Auth } from "googleapis";
import { DriveProvider } from "../DriveProvider";

// LLD §5 (invoice generation) and HLD §9 (KYC document storage — restricted
// folder, admin-only access). `uploadFile` deliberately never shares the
// uploaded file with anyone — KYC documents go to GOOGLE_KYC_FOLDER_ID
// (kept separate from GOOGLE_DRIVE_FOLDER_ID, which invoice copies use and
// individual resources get `reader` access to — see .env.example).
//
// `supportsAllDrives: true` on every call: covers the Shared Drive path
// (Workspace) — required for any Drive API call touching a Shared Drive
// item, no-op otherwise.
//
// `auth` accepts either the service account (JWT, works fine on a Workspace
// Shared Drive) or the OAuth-as-real-user client (LLD §0.18, the fallback
// for a personal/non-Workspace account — see googleOAuthClient.ts) —
// index.ts decides which one based on which credentials are configured.
export class RealDriveProvider implements DriveProvider {
  private drive: ReturnType<typeof google.drive>;
  private kycFolderId: string;

  constructor(auth: Auth.JWT | Auth.OAuth2Client) {
    this.drive = google.drive({ version: "v3", auth });
    const kycFolderId = process.env.GOOGLE_KYC_FOLDER_ID;
    if (!kycFolderId) {
      throw new Error("GOOGLE_KYC_FOLDER_ID must be set to use RealDriveProvider.");
    }
    this.kycFolderId = kycFolderId;
  }

  async copyTemplate(templateId: string, targetFolderId: string): Promise<string> {
    const res = await this.drive.files.copy({
      fileId: templateId,
      requestBody: { parents: [targetFolderId] },
      fields: "id",
      supportsAllDrives: true,
    });
    if (!res.data.id) {
      throw new Error("Drive files.copy did not return a file id");
    }
    return res.data.id;
  }

  // Resource gets `reader` access to their own invoice doc — they're
  // reviewing it (gates 1/2, LLD §0.9), not editing it. Not specified in
  // the LLD; flagged as an assumption.
  async shareWithEmail(fileId: string, email: string): Promise<void> {
    await this.drive.permissions.create({
      fileId,
      requestBody: { type: "user", role: "reader", emailAddress: email },
      sendNotificationEmail: false, // the platform's own PAYOUT_GENERATED email covers this
      supportsAllDrives: true,
    });
  }

  // LLD §0.24 — used by reprocessInvoice/regenerate-document when re-filling
  // with corrected/updated data; the old file's {{TOKENS}} are already
  // consumed and can't be refilled in place, so it gets deleted instead.
  async deleteFile(fileId: string): Promise<void> {
    await this.drive.files.delete({ fileId, supportsAllDrives: true });
  }

  async uploadFile(fileName: string, content: Buffer): Promise<string> {
    const res = await this.drive.files.create({
      requestBody: { name: fileName, parents: [this.kycFolderId] },
      media: { body: Readable.from(content) },
      fields: "id, webViewLink",
      supportsAllDrives: true,
    });
    if (!res.data.webViewLink) {
      throw new Error("Drive files.create did not return a webViewLink");
    }
    return res.data.webViewLink;
  }
}

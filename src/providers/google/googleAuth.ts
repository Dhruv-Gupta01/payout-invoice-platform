import { google } from "googleapis";

// Shared JWT auth client for the Sheets/Docs/Drive providers — built once
// from the service account credentials, scoped only to what's needed
// (HLD §9: "Service account scope: limited to the one linked Sheet and one
// Drive folder — not broad Drive/Sheets access." Scopes below are as narrow
// as the googleapis client library allows; the *folder-level* scoping HLD
// means is enforced by what the service account is actually shared on in
// Google Cloud, not by these OAuth scopes.)
const SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets.readonly",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/drive",
];

export function createGoogleAuthClient() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.replace(/\\n/g, "\n");

  if (!email || !privateKey) {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY must both be set to use real Google providers."
    );
  }

  return new google.auth.JWT({
    email,
    key: privateKey,
    scopes: SCOPES,
  });
}

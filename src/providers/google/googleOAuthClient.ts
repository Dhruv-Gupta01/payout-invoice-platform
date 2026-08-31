import { google, Auth } from "googleapis";

// Fallback auth path for a personal (non-Workspace) Google account — LLD
// §0.18. Service accounts have zero personal Drive storage quota, so
// creating/copying files into a regular "My Drive" folder fails with
// "storage quota exceeded" even when the folder is shared with the service
// account. Authenticating as the real account instead (via OAuth, one-time
// interactive consent) means files are owned by that account's real quota.
//
// Once a file is created this way, only the same OAuth-authenticated
// identity can reliably act on it further (a service account isn't
// automatically granted access to a file it didn't create and was never
// separately shared with) — so this same client is used for every
// Drive/Docs write in the invoice-generation pipeline (copy, fill, share),
// not just the copy step. Sheets reads are unaffected and stay on the
// service account (src/providers/google/googleAuth.ts) — reading was
// never the problem, only creating/writing files was.
export function createGoogleOAuthClient(): Auth.OAuth2Client {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, and GOOGLE_OAUTH_REFRESH_TOKEN must all be set to use createGoogleOAuthClient."
    );
  }

  const client = new google.auth.OAuth2(clientId, clientSecret);
  client.setCredentials({ refresh_token: refreshToken });
  return client;
}

export function hasGoogleOAuthCreds(): boolean {
  return Boolean(
    process.env.GOOGLE_OAUTH_CLIENT_ID &&
      process.env.GOOGLE_OAUTH_CLIENT_SECRET &&
      process.env.GOOGLE_OAUTH_REFRESH_TOKEN
  );
}

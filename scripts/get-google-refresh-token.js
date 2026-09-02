/*
 * One-off: obtain a Google OAuth refresh token for the Drive/Docs write path.
 *
 * Works with a "Desktop app" OAuth client (loopback redirect, no redirect URI
 * to register). Reads the client id/secret from the environment.
 *
 * Usage:
 *   npx dotenv -e .env -- node scripts/get-google-refresh-token.js
 *
 * It prints an authorization URL, opens a local server on 127.0.0.1 to catch
 * the redirect, then prints the refresh token. Put that value in
 * GOOGLE_OAUTH_REFRESH_TOKEN (Render env + local .env).
 *
 * NOTE: a non-expiring refresh token requires the OAuth consent screen to be
 * published ("In production"). While it is in "Testing", the token Google
 * issues here still expires after 7 days.
 */
const http = require("http");
const { google } = require("googleapis");

const PORT = 53789;
const SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/documents",
];

const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error("Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET (e.g. via: npx dotenv -e .env -- node scripts/get-google-refresh-token.js)");
  process.exit(1);
}

const redirectUri = `http://127.0.0.1:${PORT}`;
const oauth2 = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

const authUrl = oauth2.generateAuthUrl({
  access_type: "offline",
  prompt: "consent", // force a fresh refresh_token every run
  scope: SCOPES,
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, redirectUri);
  const code = url.searchParams.get("code");
  const err = url.searchParams.get("error");

  if (err) {
    res.end(`Authorization failed: ${err}. You can close this tab.`);
    console.error("Authorization failed:", err);
    server.close();
    process.exit(1);
  }
  if (!code) {
    res.statusCode = 400;
    res.end("No ?code in request.");
    return;
  }

  try {
    const { tokens } = await oauth2.getToken(code);
    res.end("Done. You can close this tab and return to the terminal.");
    console.log("\n=== SUCCESS ===");
    if (tokens.refresh_token) {
      console.log("\nGOOGLE_OAUTH_REFRESH_TOKEN=" + tokens.refresh_token + "\n");
      console.log("Put that in Render (Environment) and local .env, then redeploy.");
    } else {
      console.log("\nNo refresh_token returned. Revoke the app's access at");
      console.log("https://myaccount.google.com/permissions and run this again.\n");
    }
  } catch (e) {
    console.error("Token exchange failed:", e.message);
  } finally {
    server.close();
    process.exit(0);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("\n1. Open this URL in your browser (sign in as the account that owns the Drive folder):\n");
  console.log("   " + authUrl + "\n");
  console.log("2. Approve access. You'll be redirected to a localhost page and the token prints here.\n");
});

import { createApp } from "./app";
import { FakeSheetsProvider } from "./providers/fakes/FakeSheetsProvider";
import { FakeDriveProvider } from "./providers/fakes/FakeDriveProvider";
import { FakeDocsProvider } from "./providers/fakes/FakeDocsProvider";
import { FakeEmailProvider } from "./providers/fakes/FakeEmailProvider";
import { createRedisConnection } from "./queue/redisConnection";
import { RealJobQueue } from "./queue/RealJobQueue";
import { startInvoiceWorker } from "./worker/realWorkerProcess";
import { createGoogleAuthClient } from "./providers/google/googleAuth";
import { createGoogleOAuthClient, hasGoogleOAuthCreds } from "./providers/google/googleOAuthClient";
import { RealSheetsProvider } from "./providers/google/RealSheetsProvider";
import { RealDriveProvider } from "./providers/google/RealDriveProvider";
import { RealDocsProvider } from "./providers/google/RealDocsProvider";
import { RealEmailProvider } from "./providers/resend/RealEmailProvider";
import { SheetsProvider } from "./providers/SheetsProvider";
import { DriveProvider } from "./providers/DriveProvider";
import { DocsProvider } from "./providers/DocsProvider";
import { EmailProvider } from "./providers/EmailProvider";

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

// Real providers are used only when their credentials are actually present
// in env — never a silent fallback in what looks like a configured
// environment. Each mode is logged explicitly at startup so it's never
// ambiguous which one is live.
const hasGoogleCreds = Boolean(
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
);
const hasResendCreds = Boolean(process.env.RESEND_API_KEY && process.env.RESEND_FROM_EMAIL);

let sheetsProvider: SheetsProvider;
let driveProvider: DriveProvider;
let docsProvider: DocsProvider;
let emailProvider: EmailProvider;

/* eslint-disable no-console */
if (hasGoogleCreds) {
  const auth = createGoogleAuthClient();
  sheetsProvider = new RealSheetsProvider(auth);

  // Drive/Docs writes (copy/fill/share) use OAuth-as-real-user when
  // configured — the personal-account fallback for the service account's
  // 0 Drive storage quota (LLD §0.18). Falls back to the service account
  // otherwise (fine on a Workspace Shared Drive).
  if (hasGoogleOAuthCreds()) {
    const driveDocsAuth = createGoogleOAuthClient();
    driveProvider = new RealDriveProvider(driveDocsAuth);
    docsProvider = new RealDocsProvider(driveDocsAuth);
    console.log("[providers] Google Sheets: REAL (service account) — Docs/Drive: REAL (OAuth as real user)");
  } else {
    driveProvider = new RealDriveProvider(auth);
    docsProvider = new RealDocsProvider(auth);
    console.log("[providers] Google Sheets/Docs/Drive: REAL (service account)");
  }
} else {
  sheetsProvider = new FakeSheetsProvider();
  driveProvider = new FakeDriveProvider();
  docsProvider = new FakeDocsProvider();
  console.log("[providers] Google Sheets/Docs/Drive: FAKE (no service account credentials in env)");
}

if (hasResendCreds) {
  emailProvider = new RealEmailProvider();
  console.log("[providers] Email: REAL (Resend)");
} else {
  emailProvider = new FakeEmailProvider();
  console.log("[providers] Email: FAKE (no Resend credentials in env)");
}
/* eslint-enable no-console */

const queueConnection = createRedisConnection(REDIS_URL);
const workerConnection = createRedisConnection(REDIS_URL);
const jobQueue = new RealJobQueue(queueConnection);

const worker = startInvoiceWorker({
  connection: workerConnection,
  deps: { driveProvider, docsProvider, emailProvider },
});

const app = createApp({ sheetsProvider, driveProvider, docsProvider, emailProvider, jobQueue });

const server = app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Payout platform API listening on port ${PORT}`);
});

async function shutdown() {
  await worker.close();
  await queueConnection.quit();
  await workerConnection.quit();
  server.close();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

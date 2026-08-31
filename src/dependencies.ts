import { SheetsProvider } from "./providers/SheetsProvider";
import { DriveProvider } from "./providers/DriveProvider";
import { DocsProvider } from "./providers/DocsProvider";
import { EmailProvider } from "./providers/EmailProvider";
import { JobQueue } from "./queue/JobQueue";

// Shared dependency-injection shape: the app and its per-namespace routers
// (admin, resource) all take this, so tests can swap in fakes for external
// providers (rule: no real external calls in tests).
//
// docsProvider added per LLD §0.24 — POST /admin/invoices/:invoiceId/regenerate-document
// is a synchronous admin action (unlike normal generation, which only ever
// touches Docs from the async worker), so the app itself now needs it too.
export interface AppDependencies {
  sheetsProvider: SheetsProvider;
  driveProvider: DriveProvider;
  docsProvider: DocsProvider;
  emailProvider: EmailProvider;
  jobQueue: JobQueue;
}

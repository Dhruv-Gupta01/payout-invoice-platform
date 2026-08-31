# Low-Level Design: Resource Payout & Invoice Automation Platform

**Status:** Draft v1 — implementation-ready except where marked TBD
**Companion doc:** `HLD-payout-invoice-platform.md`

---

## 0. What's intentionally deferred

The **credential/invite flow** (how a resource or admin gets their first login) was decided separately and is now designed and built — see §0.25. Everywhere this doc previously said `[TBD: invite flow]`, that's now resolved.

**Payout reconciliation** (matching a bank-paid-transactions file against generated invoices) was also decided separately and is now designed — see §0.26. Everywhere this doc previously said `[TBD: payout reconciliation]`, that's now resolved.

Three refinements surfaced while writing at this level of detail, not present in the HLD — flagged here since they correct/sharpen earlier decisions:

1. **Sync must be an upsert by natural key, not delete-and-reinsert.** The HLD says the sheet "fully replaces" data on each sync — but `Invoice` rows hold a foreign key to `SheetRow`. A literal delete-and-reinsert would orphan every generated invoice's reference on the next sync. Fixed below: sync **matches existing rows by `(resourceEmail, projectName, batch, month)`** and updates their fields, rather than deleting and recreating. "Replace" means field values get overwritten, not that row identity is discarded.
2. **Invoice status is split into two fields, not one.** A single `status` enum was conflating two different lifecycles: whether generation succeeded (`queued → processing → generated/failed`) and whether the resource has approved it (`pending → approved/declined`). Split into `generationStatus` and `approvalStatus` below — cleaner to query and reason about.
3. **The admin sends explicit row IDs to generate invoices, not a numeric range.** "Start row / end row" is a UI convenience for selecting a contiguous block in the visible table — but row *position* isn't a stable backend identifier once upserts are involved. The frontend resolves the visual range into a list of `sheetRowId`s and sends that.
4. **`SheetRow` needs a `resourceName` field.** Sync creates a `Resource` when a row's email doesn't match an existing one (HLD §5.1), but `Resource.name` is required and nothing in the original schema carried a name — `SheetRow` had `resourceEmail` but no name counterpart, and onboarding never collects one either. Fixed below: `SheetRow.resourceName` mirrors `resourceEmail`, supplied per row by the `SheetsProvider`. Sync uses it both to set `Resource.name` on first creation **and** to keep it in sync on every subsequent sync — consistent with the HLD's "sheet is always authoritative, full-replace" decision (§3 decision table), the same way `SheetRow`'s other fields get overwritten rather than left stale.
5. **`invoiceNo` numbering scheme.** `"INV-0001"` appears only as a format example (§2.3, §4) — the generation algorithm was never specified. Fixed: **one global sequential counter**, zero-padded to 4 digits (`INV-0001`, `INV-0002`, ...; grows past 4 digits beyond `INV-9999`), computed as count-of-existing-invoices+1 inside the same DB transaction that creates the `Invoice` row — atomic within one `/admin/invoices/generate` batch. Matches the HLD's low-hundreds-of-resources, no-continuous-throughput scale (§4 NFR); a dedicated Postgres sequence wasn't judged necessary at this volume. Cross-request races (two admins generating simultaneously) are not separately guarded beyond the `invoiceNo` unique constraint — accepted as a low-probability risk at this scale, not retried automatically.
6. **`Invoice` needs a `batchId` field.** `GET /admin/invoices/status/:batchId` (§2.3) polls the status of one generation batch, but nothing in the original schema recorded which invoices belong to which batch — no `Batch` model, no field on `Invoice`. Fixed: `Invoice.batchId` (nullable `String`), set to a generated UUID shared by every `Invoice` — clean or flagged — created in one `/admin/invoices/generate` call. No separate `Batch` table; nothing else in the spec needs one.
7. **Generic "notify Admin" events need a configured recipient.** HLD §7 lists two events with recipient "Admin" (`Invoice declined`, `Document re-uploaded after rejection`) but never says which admin, and unlike document rejection (which has `Document.reviewedById` to fall back on), `Invoice` has no admin reference at all. Fixed: a configured `ADMIN_NOTIFICATION_EMAIL` env var — one fixed recipient regardless of how many `AdminUser` rows exist — used for `INVOICE_DECLINED`. (Note: `DOCUMENT_REUPLOADED`, built in Phase 5 before this was resolved, still notifies the specific rejecting admin via `reviewedById` — an inconsistency with this decision, flagged for you to decide whether to unify.)
8. **`GET /admin/invoices/status/:batchId` and `POST /admin/invoices/:invoiceId/retry` (§2.3), and the whole "Invoices — listing and resource actions" endpoint set (§2.4: `GET /admin/invoices`, `GET /resource/invoices`, approve, decline) were never assigned to a build-plan phase.** Fixed: added as Phase 6.5 in the build plan, between Bank Lock/Unlock and Queue Wiring.
9. **Invoice approval becomes two sequential gates, not one — correction from the team, post-launch-planning.** Originally the resource reviewed one thing — the generated invoice document — via `approvalStatus` (`PENDING → APPROVED/DECLINED`). Corrected: the resource must first confirm the **computed payout amount** before the invoice document is ever shown to them. Generation timing is unchanged (HLD §5.2 step 4 still fires immediately, in the background) — only *visibility* is gated. Fixed: a new, independent `amountConfirmationStatus` (`PENDING → CONFIRMED/REJECTED`) on `Invoice`. `driveDocUrl` is withheld from `GET /resource/invoices` (§2.4) and the existing approve/decline endpoints (gate 2) reject with 403 until gate 1 is `CONFIRMED`. The resource-facing "ready" notification is renamed `PAYOUT_GENERATED` (same trigger point as the old `INVOICE_GENERATED` — end of successful generation — but no document link, since gate 1 hasn't passed yet). Rejecting gate 1 fires a new `AMOUNT_REJECTED` notification to admin (same `ADMIN_NOTIFICATION_EMAIL` recipient as `INVOICE_DECLINED`, §0.7) and holds the row in a terminal state — generation already happened against what turned out to be wrong data, so nothing auto-retries. An admin must correct the underlying data (re-sync) and explicitly call the new `POST /admin/invoices/:invoiceId/reprocess` (§2.3), which re-derives `amount` from the corrected `SheetRow`, resets both `amountConfirmationStatus` and `generationStatus` to their start states, and re-enqueues — reusing the same `Invoice` row and `driveFileId` (refills the same Drive file with corrected content) rather than orphaning a fresh one, consistent with the idempotent-resume principle already established for retries (§6).
10. **Payout reconciliation — deferred, not yet specified.** After a resource approves their invoice (gate 2), Biz-Tech's finance process pays it outside the platform (per HLD §1 scope) and later shares a payouts-done CSV/Excel. The intent is for the platform to compare that file against approved+generated invoices and email admins the ones invoiced but not found in the file — but the CSV's column format, the exact matching key (invoice number vs. resource+amount), which invoice states are eligible, and the notification recipient(s) are all undecided. Marked **`[TBD: payout reconciliation]`**. Confirmed as in-scope, targeted for a later phase — no schema or endpoint committed yet.
11. **`{{AMOUNT_IN_WORDS}}` (§4) conversion method — never specified.** Fixed: the `to-words` npm package, `en-IN` locale (lakh/crore grouping, matching the PAN/IFSC/Aadhaar Indian-payroll context), currency mode on. Implemented in `src/invoices/amountInWords.ts`, tested directly (pure function, no external call).
12. **Email subject/body copy for all seven notification events — never specified anywhere in the LLD/HLD.** Fixed: draft copy per event in `src/notifications/emailTemplates.ts` (`buildEmailContent`), reviewed by the user before use in `RealEmailProvider`. References a human-readable `ref` (invoice number, document type, or resource name) resolved by `RealEmailProvider` from `relatedId` — never a raw database id in an email.
13. **KYC document storage location — `GOOGLE_DRIVE_FOLDER_ID` (invoices) was the only Drive folder configured.** HLD §9 calls for KYC documents (Aadhaar/PAN/bank proof) to sit in a "restricted" folder, admin-only access — but invoice docs get `reader`-shared with individual resources, so storing KYC files in the same folder risks a resource's Drive permissions overlapping into other resources' KYC documents. Fixed: a separate `GOOGLE_KYC_FOLDER_ID` env var, never shared with any resource; `DriveProvider.uploadFile` (used only for KYC uploads, LLD §2.7) always targets it.
14. **Resource's Drive permission role on their own invoice doc — not specified.** Fixed: `reader`, not `writer` — they're reviewing it (gates 1/2, §0.9), not editing it. Flagged as an assumption, not confirmed with the user.
15. **Sheet column layout — never specified.** `RealSheetsProvider` reads the header row and matches columns by name (case/whitespace-insensitive aliases) rather than assuming a fixed position, to reduce (not eliminate) the risk of silently misreading real payout data. Confirmed against the real sheet (Phase 8) — two of the original guesses didn't match: the real headers are `Hour ` (singular, trailing space) and `Rate (INR)`, not `Hours`/`Rate`. Fixed: added `hour`/`rateinr` as additional normalized aliases. Also confirmed the real `Rate (INR)` column stores values like `"100/hr"` (a trailing unit, not a clean number) — a naive `Number()` parse would silently read this as `NaN → 0`, corrupting real payout amounts. Fixed: `parseLeadingNumber` (`src/providers/google/sheetNumberParsing.ts`) extracts the leading numeric token instead, tested directly. Also caught floating-point noise in `hours × rate` (e.g. `34.3 × 100 = 3429.9999999999995`) — fixed with `roundMoney`, same file, rounds to 2 decimal places (paise) before storing.
16. **`computedAmount` is computed by us, `sheetAmount` is read from the sheet — clarifying an ambiguity the real sheet exposed.** The real sheet's `Amount` column is blank on most rows (confirmed, Phase 8) — consistent with it being the *optional override* (`sheetAmount`) the LLD §1 comment already describes, not a value we should read as `computedAmount` directly. Fixed: `RealSheetsProvider` always computes `computedAmount = hours × rate` itself; the sheet's `Amount` column (when filled) maps to `sheetAmount`. No change to the existing `sheetAmount ?? computedAmount` resolution already built in `invoiceGenerationService.ts` since Phase 3 — this just makes `RealSheetsProvider` populate both fields consistently with what that logic always expected.
17. **Real-sheet blocker, not a code gap: every row in the real sheet has an empty `Email` column.** Confirmed against all 27 real rows (Phase 8) — sync's existing skip-on-missing-email behavior (LLD §2.2, built and tested since Phase 2) would correctly skip every one of them; nothing would sync. Also observed: the same person's name appears under different roles/casing in the same batch (e.g. "Kathryn" as both Annotator and QCer; "SHUBHAM SWAMI" vs "Shubham Swami") — matching by name instead wouldn't be reliable either. Resolved for testing by adding one row with a real email; the other 27 remain blocked on real data entry, not code.
18. **Real infrastructure blocker, first hit during the Phase 8 smoke test, now resolved: service accounts have zero personal Google Drive storage quota.** `copyTemplate` failed with "The user's Drive storage quota has been exceeded" on the first real generation attempt — a well-known Google limitation, not a bug: a service account creating/copying a file into a regular ("My Drive") folder is normally the file's owner, and service accounts get 0 bytes of personal storage regardless of what's shared with them. The standard fix (Shared Drive, org-level storage) needs Google Workspace — the folders in this case live under a personal Gmail account, so that route wasn't available. **Fixed instead with OAuth-as-real-user**: `src/providers/google/googleOAuthClient.ts` — a one-time interactive consent flow (the user, not the service account, authorizes the app; standard "Sign in with Google" pattern) produces a long-lived refresh token (`GOOGLE_OAUTH_CLIENT_ID`/`_SECRET`/`_REFRESH_TOKEN`). `RealDriveProvider` and `RealDocsProvider` use this client instead of the service account whenever it's configured — files are then owned by the real account's real quota, no cost, no Workspace needed. `RealSheetsProvider` is unaffected and stays on the service account (reading was never the problem). `supportsAllDrives: true` (added to every `RealDriveProvider` call) is kept too — harmless now, but means the same code also works unmodified if the folders ever do move to a Workspace Shared Drive later, without needing the OAuth path at all in that case.
19. **Verified end-to-end against real Google/Resend APIs (Phase 8 smoke test, complete):** sync (28 rows, 1 new resource, 27 correctly skipped for missing email) → generate (real Drive copy, real Docs fill — all 16 placeholders correct, including `{{AMOUNT_IN_WORDS}}` → "Two Thousand Five Hundred Rupees Only" — real `PAYOUT_GENERATED` email sent) → gate 1 confirm-amount (`driveDocUrl` correctly null before, populated after — LLD §0.9's gating proven for real, not just against fakes) → gate 2 approve. Every step matched the fake-provider-based test suite's behavior exactly.
20. **No endpoint ever specified for listing `SheetRow`s — surfaced building Phase 9's Dashboard screen against the real frontend.** §2.3 says `POST /admin/invoices/generate`'s `sheetRowIds` is "resolved client-side from the selected row range" — implying the client already has a list of rows to select from — but no `GET` anywhere in this doc returns `SheetRow`s. Flagged to the user rather than invented silently; confirmed to add. Fixed: `GET /admin/sheet-rows` (§2.3) — one row per synced `SheetRow`, with its `Invoice` status if one exists yet (`null` before generation, i.e. the Dashboard's "Not Generated" state). Excludes `removedFromSheet` rows.
21. **`GET /resource/profile` (§2.6) didn't expose `onboardingCompleted` — surfaced wiring Phase 9's Login screen.** After `POST /auth/login`, the frontend needs to redirect a resource to `/onboarding` or `/invoices`, but neither the login response nor `GET /resource/profile` said which state they're in (only the admin-side `GET /admin/resources/:id` had the field). Flagged to the user, confirmed, added: `GET /resource/profile` now returns `onboardingCompleted` too.
22. **Documents listing (§2.7) didn't expose an `id` — surfaced wiring Phase 9's admin Resource-detail screen.** `POST /admin/documents/:id/verify` and `/reject` need a specific `Document` id, but neither `GET /resource/documents` nor `GET /admin/resources/:id/documents` returned one — the admin UI had no way to call those actions from the list. Flagged to the user, confirmed, added: both now include `id`.
23. **New rule, user-requested: invoice generation must not proceed for a resource who hasn't finished onboarding or whose documents aren't all verified — checked and reported separately.** Previously `POST /admin/invoices/generate` only checked duplicate/stale-amount (§3); nothing stopped generating an invoice for someone mid-onboarding. Reuses the existing FLAGGED/flagReason mechanism (§2.3) rather than inventing a new state, but with a key difference: duplicate/stale-amount reasons remain an admin judgment call (freely overridable via acknowledge-flag, as before), while onboarding/documents reasons are **not** — `acknowledge-flag` now re-checks specifically those two conditions at acknowledge time and refuses (400) if either still fails, regardless of what the admin clicks. "Documents verified" means all 5 required types (`AADHAAR`, `PAN`, `PHOTO`, `BANK_PROOF`, `NDA`) have a `Document` row with `status = VERIFIED` — missing, pending-review, and rejected all count as "not ready."
24. **Serious bug found live (not caught by the test suite, since it only exercises `FakeDocsProvider`): `reprocessInvoice`'s "reuse the same Drive file" design (§2.3, since Phase 6) silently fails to update the document.** `buildPlaceholderRequests` (§4) works by searching for literal `{{TOKEN}}` text and replacing it — that only works once. After a document is filled, the tokens are gone, replaced with real text; a second `batchUpdate` searching for the same tokens finds nothing and no-ops (Google's API reports success with 0 replacements, it doesn't error). `reprocessInvoice` reuses `driveFileId` and re-runs `buildPlaceholderRequests` with a *corrected* amount — but since the document was already fully filled once (generation completes, gate 1 can only be rejected after that), the correction never actually reaches the document. Never caught in Phase 8's real-doc smoke test either, since that only covered the happy path (confirm → approve), not reject → reprocess. **Fixed, user-confirmed:** `reprocessInvoice` now deletes the old Drive file (`DriveProvider.deleteFile`, new interface method) and clears `driveFileId` before re-enqueuing, so the worker's existing `if (!driveFileId)` guard (§6) copies a fresh template — guaranteed-clean tokens every time. Same root cause motivated the new `regenerate-document` endpoint (§2.3, user-requested, for the case where a resource's profile is completed *after* their invoice was already generated) — it uses the identical delete-old-file-and-copy-fresh approach, but unlike `reprocessInvoice` it runs synchronously (not queued) and deliberately leaves `amountConfirmationStatus`/`approvalStatus` untouched and sends no notification, since it's correcting a document's contents, not re-running generation.
25. **Invite/credential flow, decided (resolves the original `[TBD: invite flow]` deferral from this section's header).** A `Resource` gets created by sync with no password (`passwordHash` stays null). Admin explicitly triggers `POST /admin/resources/:id/send-invite` (user-confirmed: manual, not automatic on sync — the real sheet has messy/duplicate data, e.g. the same person under different casing per §0.17, and auto-emailing on every new row risks inviting the wrong person off a typo). That generates a random token (`Resource.inviteToken`, unique) with a 7-day expiry (`inviteTokenExpiresAt`, flagged as my default), fires `INVITE_SENT` with a link to `/accept-invite?token=...`. Calling send-invite again before acceptance overwrites the token — that's how "resend" works, no separate endpoint. `POST /auth/accept-invite` verifies the token, sets the password, clears the token, and logs them in immediately (same response shape as login) — no separate login step after accepting. **Scoped to resources only** — `AdminUser` accounts stay manually seeded, same as every admin account has been so far; not treated as a gap, just out of scope (a handful of trusted internal staff, not a self-service population). The invite email is subject to the same Resend test-domain limitation as every other notification — won't actually reach a real resource until the domain is verified.

26. **Payout reconciliation, decided (resolves the `[TBD: payout reconciliation]` deferral in note 10 above).** Nitin (admin) periodically shares a bank-exported CSV of NEFT transactions actually paid, to be cross-checked against generated+approved invoices. A real sample was reviewed: columns `Sr. No, Txn Type, Credit Account No., Credit Account Name, IFSC, Amount, Narration` — notably **no invoice number and no email**; `Narration` is always a generic string (e.g. "Service Charges"), confirmed by the user, so it carries no matching signal. Decided, user-confirmed:
    - **Matching key:** `Credit Account No.` + `IFSC` identify *which* `Resource` (matched against `Resource.accountNo`/`Resource.ifsc`) — the free-text `Credit Account Name` column is not used for matching, same messy-data reasoning as note 17 (real names aren't reliable identifiers). `Amount` then picks *which* of that resource's eligible invoices got paid.
    - **Eligible invoices:** only `generationStatus = GENERATED`, `approvalStatus = APPROVED`, `paidAt = null` (a new nullable `Invoice.paidAt`, set once matched — this is also the durable "already reconciled" record; see the audit-trail decision below).
    - **Unambiguous match** (exactly one eligible invoice for that resource+amount): `paidAt` set immediately to the reconciliation run's timestamp.
    - **Ambiguous match** (a resource has more than one eligible invoice at the same amount — e.g. two identical months): none are auto-marked paid. Reported back in the response as a group of candidate invoice ids against one bank row; the admin resolves it manually via a new `POST /admin/invoices/:invoiceId/mark-paid` (also usable as a general manual override).
    - **Not paid:** any eligible invoice left with `paidAt` still null after the whole file is processed. Fires a new `INVOICE_NOT_PAID` notification to `ADMIN_NOTIFICATION_EMAIL` (same recipient pattern as `INVOICE_DECLINED`/`AMOUNT_REJECTED`, note 7) — **not** the resource, since a delay could just mean this cycle's payout batch hasn't run yet. De-duplicated by checking `NotificationLog` for an existing `SENT` row (`eventType = INVOICE_NOT_PAID`, `relatedId = invoice.id`) before sending — otherwise re-running reconciliation on a later file would re-email the same still-unpaid invoice every time.
    - **Unrecognized rows:** a bank row whose `Credit Account No.` + `IFSC` don't match any resource (or match a resource but no eligible invoice at that amount) is not silently dropped — reported back in the response as its own list, for visibility only, no notification.
    - **Audit trail:** stateless, user-confirmed — no separate `ReconciliationRun` model. The only persisted effect is `Invoice.paidAt` (and the `NotificationLog` rows from the dedup check above); the response itself is the report, not stored.
    - **Trigger:** manual admin upload, `POST /admin/reconciliation` (§2.3) — multipart CSV, same `multer` memory-storage pattern already used for document uploads (§2.7). No bank API integration exists or was requested.
    - **Format:** CSV only for now (`csv-parse`, handles the quoted-comma amounts real bank exports use, e.g. `"16,621.00"`) — Excel (`.xlsx`) support was not requested; can be added later behind the same parsing step if Nitin's exports turn out to need it.

27. **Reconciliation admin UI, user-requested.** New `/reconciliation` page (nav item added to `AppSidebar`): upload the bank CSV, see the four result buckets (matched / ambiguous / not paid / unrecognized rows), and resolve an ambiguous match with a "Mark paid" button per candidate invoice. Surfaced one contract gap while wiring it: the `ambiguous` response shape (§2.3) originally returned bare `candidateInvoiceIds: string[]` — not enough to render a pickable list without a second round-trip per id. Fixed: `candidates: [{ invoiceId, invoiceNo }]` instead, same reasoning as notes 20-22 (never show a raw database id where a human-readable reference is available).

28. **Auto-clearing a FLAGGED invoice once the resource actually becomes ready — real gap found live, user-requested.** §0.23 added the onboarding/documents readiness gate, but nothing ever re-checked a resource's FLAGGED invoices when the blocking condition cleared — `verifyDocument` only touched its own `Document` row, `completeOnboarding` only touched `Resource`; neither looked at `Invoice` at all. A resource who finished onboarding and got every document verified still sat FLAGGED indefinitely until an admin manually clicked "Acknowledge & queue". Fixed: both now call a new `autoClearReadyFlags(resourceId, jobQueue)` (`invoiceGenerationService.ts`) afterward. Deliberately narrow — it only auto-queues a FLAGGED invoice whose `flagReason` was *exclusively* onboarding/documents; one that's *also* flagged for duplicate/stale-amount (§3, a judgment call) is left alone, still requiring an explicit `acknowledge-flag` click, exactly as before. Detected by string-matching the stored `flagReason` for the duplicate/amount markers, rather than re-running `checkHardFlag`/`checkSoftFlag` — those match "any invoice sharing this sheetRow's resourceEmail/project/batch", which by the time this runs includes the invoice being checked itself (it didn't exist yet at the original check) — a guaranteed self-match that would make the hard flag look permanently true forever. No `flagAcknowledgedBy`/`flagAcknowledgedAt` stamp on an auto-clear — nobody made an override decision, the condition just became false.

29. **Gate-2 decline had no recovery path at all — real gap found live, user-requested.** Gate 1 (amount rejection) has `reprocess` (§0.9/§2.3) to fix and retry; gate 2 (`approvalStatus = DECLINED`, the resource declining the actual invoice document) had nothing — no endpoint anywhere lets an admin move a declined invoice back out of that terminal state. Discovered live testing the reconciliation/auto-clear work this session, not something the LLD ever specified either way. Fixed: `POST /admin/invoices/:invoiceId/reopen` (§2.3), user-confirmed design — resets `approvalStatus` to `PENDING` and clears `declineReason`/`actionedAt`, nothing else. Deliberately narrow, two decisions the user made explicitly: (1) it does **not** touch `amountConfirmationStatus` — gate 1 already passed, no reason to make the resource redo it; (2) it does **not** regenerate the document — kept as a separate, composable step (call the existing `regenerate-document`, §0.24, first if the document itself needs correcting, then this) rather than one endpoint that always does both, matching how `reprocess`/`regenerate-document` are already split. Fires a new `INVOICE_REOPENED` notification to the resource (their turn to act again) — user-confirmed, same reasoning as `BANK_UNLOCKED` (an admin action that hands the ball back to the resource always notifies them).

---

## 1. Prisma Schema

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model AdminUser {
  id           String   @id @default(uuid())
  email        String   @unique
  passwordHash String
  name         String
  createdAt    DateTime @default(now())

  documentsReviewed Document[]      @relation("DocumentReviewer")
  bankUnlocks       BankUnlockLog[] @relation("UnlockedBy")
}

model Resource {
  id                String   @id @default(uuid())
  email             String   @unique
  name              String
  address           String?
  contactNo         String?
  pan               String?
  beneficiaryName   String?
  accountNo         String?
  bankName          String?
  ifsc              String?
  passwordHash      String?  // null until account activated via the invite flow (§0.25)
  inviteToken       String?  @unique // set by POST /admin/resources/:id/send-invite; cleared once accepted
  inviteTokenExpiresAt DateTime? // §0.25 — 7 days from send
  onboardingCompleted Boolean @default(false)
  bankLocked        Boolean  @default(false)
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  sheetRows      SheetRow[]
  invoices       Invoice[]
  documents      Document[]
  bankUnlockLogs BankUnlockLog[]

  @@index([email])
}

model SheetRow {
  id              String    @id @default(uuid())
  resourceEmail   String
  resourceName    String    // mirrors resourceEmail — used to set/refresh Resource.name on sync (see §0.4)
  resource        Resource? @relation(fields: [resourceEmail], references: [email])
  month           String
  projectName     String
  batch           String
  role            String
  hours           Decimal
  rate            Decimal
  computedAmount  Decimal
  sheetAmount     Decimal?  // raw value from the sheet, if present — used as an override if filled
  rawData         Json      // full row as synced, for anything not yet modeled
  removedFromSheet Boolean  @default(false) // true if a later sync no longer contains this row
  lastSyncedAt    DateTime  @default(now())
  createdAt       DateTime  @default(now())

  invoice Invoice?

  @@unique([resourceEmail, projectName, batch, month], name: "sheet_row_natural_key")
  @@index([resourceEmail])
}

enum GenerationStatus {
  FLAGGED     // held pending admin acknowledgment (duplicate/amount flag)
  QUEUED      // job enqueued, not yet started
  PROCESSING  // worker actively generating
  GENERATED   // doc created successfully
  FAILED      // retries exhausted
}

enum ApprovalStatus {
  NOT_APPLICABLE // generation not yet complete
  PENDING
  APPROVED
  DECLINED
}

// Gate 1 (§0.9) — confirming the computed payout amount, before the
// resource ever sees the invoice document. Independent of both
// GenerationStatus (generation is not gated on this) and ApprovalStatus
// (gate 2 — reviewing the document itself, only actionable once this is
// CONFIRMED).
enum AmountConfirmationStatus {
  PENDING
  CONFIRMED
  REJECTED
}

model Invoice {
  id                 String           @id @default(uuid())
  invoiceNo          String           @unique   // business-facing, e.g. "INV-0001"
  batchId            String?          // groups invoices created by one /admin/invoices/generate call (see §0.6)
  sheetRowId         String           @unique
  sheetRow           SheetRow         @relation(fields: [sheetRowId], references: [id])
  resourceId         String
  resource           Resource         @relation(fields: [resourceId], references: [id])

  amount             Decimal
  amountInWords      String?          // filled once generated
  invoiceDate        DateTime?

  driveFileId        String?          // set immediately after template copy — enables safe retry
  driveDocUrl         String?

  generationStatus   GenerationStatus @default(QUEUED)

  amountConfirmationStatus AmountConfirmationStatus @default(PENDING) // gate 1 — see §0.9
  amountConfirmedAt        DateTime?                                 // gate 1 timestamp (confirm or reject)
  amountRejectionReason    String?

  approvalStatus     ApprovalStatus   @default(NOT_APPLICABLE)       // gate 2 — only actionable once amountConfirmationStatus = CONFIRMED
  declineReason      String?
  actionedAt         DateTime?        // when resource approved/declined (gate 2 only)

  flagReason         String?          // set if held by duplicate/amount detection
  flagAcknowledgedBy String?          // AdminUser id
  flagAcknowledgedAt DateTime?

  paidAt             DateTime?        // set by reconciliation (§0.26) once matched against a bank file row

  errorMessage       String?          // set if generationStatus = FAILED

  createdAt          DateTime         @default(now())
  updatedAt          DateTime         @updatedAt

  @@index([resourceId])
  @@index([generationStatus])
  @@index([batchId])
}

enum DocumentType {
  AADHAAR
  PAN
  PHOTO
  BANK_PROOF
  NDA
}

enum DocumentStatus {
  PENDING_REVIEW
  VERIFIED
  REJECTED
}

model Document {
  id              String         @id @default(uuid())
  resourceId      String
  resource        Resource       @relation(fields: [resourceId], references: [id])
  docType         DocumentType
  fileUrl         String         // Google Drive file link
  status          DocumentStatus @default(PENDING_REVIEW)
  rejectionReason String?
  reviewedById    String?
  reviewedBy      AdminUser?     @relation("DocumentReviewer", fields: [reviewedById], references: [id])
  reviewedAt      DateTime?
  uploadedAt      DateTime       @default(now())
  updatedAt       DateTime       @updatedAt

  @@unique([resourceId, docType]) // one active document per type; re-upload overwrites this row
}

model BankUnlockLog {
  id           String    @id @default(uuid())
  resourceId   String
  resource     Resource  @relation(fields: [resourceId], references: [id])
  unlockedById String
  unlockedBy   AdminUser @relation("UnlockedBy", fields: [unlockedById], references: [id])
  unlockedAt   DateTime  @default(now())
  editedAt     DateTime? // set when the resource actually saves
  reLockedAt   DateTime?

  @@index([resourceId])
}

enum NotificationEvent {
  PAYOUT_GENERATED    // renamed from INVOICE_GENERATED (§0.9) — same trigger point, no document link
  DOCUMENT_VERIFIED
  DOCUMENT_REJECTED
  BANK_UNLOCKED
  INVOICE_DECLINED
  DOCUMENT_REUPLOADED
  AMOUNT_REJECTED     // new (§0.9) — resource rejects gate 1, notifies admin
  INVITE_SENT         // new (§0.25) — admin sends/resends a resource's invite link
  INVOICE_NOT_PAID    // new (§0.26) — reconciliation ran, this eligible invoice wasn't found in the bank file
  INVOICE_REOPENED    // new (§0.29) — admin reopens a DECLINED invoice back to pending, resource notified
}

enum NotificationStatus {
  SENT
  FAILED
}

model NotificationLog {
  id             String              @id @default(uuid())
  eventType      NotificationEvent
  recipientEmail String
  relatedType    String              // "invoice" | "document" | "resource"
  relatedId      String
  sentAt         DateTime            @default(now())
  status         NotificationStatus  @default(SENT)
  errorMessage   String?
}
```

---

## 2. API Contracts

Base URL assumed: `/api`. All `/admin/*` and `/resource/*` routes require a valid session; middleware checks the session's role against the route namespace and rejects (403) on mismatch. Resource-scoped routes never accept a resource ID from the client — it's always read from the session.

### 2.1 Auth

```
POST /auth/login
Request:  { email: string, password: string }
Response 200: { id, email, name, role: "admin" | "resource" }  (+ sets session cookie)
Response 401: { error: "Invalid credentials" }

GET /auth/me
Response 200: { id, email, name, role }
Response 401: { error: "Not authenticated" }

POST /auth/logout
Response 204

POST /auth/accept-invite   // added per §0.25 — resolves the invite-flow TBD, resource-only
Request: { token: string, password: string }
Response 200: { id, email, name, role: "resource" }  (+ sets session cookie — same shape as login,
  logged in immediately, no separate login step needed)
Response 400: { error: "Invalid or expired invite link" }
```
Admin accounts stay manually seeded (as every admin account has been so far) — no self-service invite flow for `AdminUser`, per §0.25.

### 2.2 Sync (Admin)

```
POST /admin/sync
Response 200: {
  syncedAt: string,
  rowsProcessed: number,
  newResourcesCreated: number,
  rowsUpdated: number,
  rowsUnchanged: number,
  skipped: [{ rowRef: string, reason: string }]  // e.g. missing/invalid email
}
```
Matching logic:
- Email is lowercased + trimmed before matching against `Resource.email` or the `SheetRow` natural key.
- Rows with missing or malformed email are skipped and reported in `skipped`, not silently dropped and not failing the whole sync.
- A row present in a previous sync but absent from the current one is marked `removedFromSheet = true`, not deleted — preserves any `Invoice` history tied to it.

### 2.3 Invoice Generation (Admin)

```
POST /admin/invoices/generate
Request: { sheetRowIds: string[] }   // resolved client-side from the selected row range
Response 200: {
  batchId: string,
  clean: [{ sheetRowId, invoiceId }],       // Invoice created, generationStatus = QUEUED, job enqueued
  flagged: [{ sheetRowId, invoiceId, flagReason }]  // Invoice created, generationStatus = FLAGGED, no job yet
}
  // flagReason (§3) now also covers resource readiness, added per §0.23:
  //   "Resource has not completed onboarding"
  //   "N document(s) not yet verified (Aadhaar card, PAN card, ...)"
  // Unlike the duplicate/stale-amount reasons below, these two are NOT an admin judgment
  // call — acknowledge-flag re-checks them and refuses (400) if still true.

POST /admin/invoices/:invoiceId/acknowledge-flag
Response 200: { invoiceId, generationStatus: "QUEUED" }  // now enqueues the job
Response 400: { error: "..." }   // added per §0.23 — refused if the underlying readiness
  // problem (onboarding/documents, not duplicate/stale-amount) still isn't fixed

GET /admin/invoices/status/:batchId
Response 200: {
  batchId, total,
  counts: { queued, processing, generated, failed, flagged }
}

POST /admin/invoices/:invoiceId/retry   // only valid when generationStatus = FAILED
Response 200: { invoiceId, generationStatus: "QUEUED" }

POST /admin/invoices/:invoiceId/reprocess   // only valid when amountConfirmationStatus = REJECTED (§0.9)
Response 200: { invoiceId, amountConfirmationStatus: "PENDING", generationStatus: "QUEUED" }
  // re-derives `amount` from the current SheetRow, resets both statuses, re-enqueues.
  // Fixed per §0.24 — deletes the old Drive file and clears driveFileId so the worker
  // copies a fresh template; no longer reuses the old file (see §0.24 for why).

POST /admin/invoices/:invoiceId/regenerate-document   // added per §0.24 — only valid when generationStatus = GENERATED
Response 200: { invoiceId, driveDocUrl }
Response 400: { error: "Invoice has not been generated yet" }
  // Re-fills the invoice document from *current* resource/sheetRow data — for when a
  // resource's profile was completed after their invoice was already generated (see §0.24).
  // Deletes the old Drive file, copies a fresh template, refills, re-shares. Does NOT touch
  // amountConfirmationStatus/approvalStatus and does NOT re-notify — this only corrects the
  // document's contents, it isn't a new generation event.

POST /admin/invoices/:invoiceId/reopen   // added per §0.29 — only valid when approvalStatus = DECLINED
Response 200: { invoiceId, approvalStatus: "PENDING" }
Response 400: { error: "Invoice is not in a DECLINED state" }
  // Recovery flow for a gate-2 decline (previously a dead end — see §0.29). Resets
  // approvalStatus to PENDING, clears declineReason/actionedAt. Does NOT touch
  // amountConfirmationStatus and does NOT regenerate the document — call
  // regenerate-document first if the document itself needs correcting, then this.
  // Fires INVOICE_REOPENED to the resource (their turn to act again).

GET /admin/sheet-rows   // added per §0.20 — lists rows for the Dashboard's row-range selection
Response 200: [{
  id, resourceName, resourceEmail, projectName, batch, role,
  hours, rate, computedAmount,
  invoiceId: string | null,          // null until /admin/invoices/generate is called for this row
  generationStatus: string | null    // null while invoiceId is null
}]
  // Excludes rows where removedFromSheet = true. Ordered by lastSyncedAt then createdAt.

POST /admin/reconciliation   // added per §0.26 — multipart CSV upload (field name "file")
Response 200: {
  matched: [{ invoiceId, invoiceNo, resourceId, resourceName, amount, creditAccountNo }],
    // paidAt set immediately to the run's timestamp
  ambiguous: [{ resourceId, resourceName, amount, creditAccountNo, candidates: [{ invoiceId, invoiceNo }] }],
    // more than one eligible invoice at this resource+amount — none auto-marked; resolve via
    // POST /admin/invoices/:invoiceId/mark-paid below (invoiceNo included per candidate, added
    // wiring the frontend, so the admin isn't shown a bare id to pick between — same reasoning
    // as notes 20-22)
  notPaid: [{ invoiceId, invoiceNo, resourceId, resourceName, amount }],
    // eligible (GENERATED + APPROVED + paidAt null) but not found anywhere in this file —
    // fires INVOICE_NOT_PAID to ADMIN_NOTIFICATION_EMAIL, deduped against NotificationLog
    // so re-running reconciliation doesn't re-email the same still-unpaid invoice
  unrecognizedRows: [{ srNo, creditAccountNo, creditAccountName, ifsc, amount, reason }]
    // reason: "no matching resource" | "resource found but no matching invoice amount"
}
Response 400: { error: "..." }   // missing file, or unparseable CSV (missing required columns)
  // Matching key: Credit Account No. + IFSC → Resource (Resource.accountNo/ifsc), then Amount →
  // which of that resource's eligible invoices. Eligible = generationStatus GENERATED,
  // approvalStatus APPROVED, paidAt null. Stateless — no separate run record persisted (§0.26).

POST /admin/invoices/:invoiceId/mark-paid   // added per §0.26 — manual override, e.g. resolving an ambiguous match
Response 200: { invoiceId, paidAt }
Response 400: { error: "Invoice is not eligible to be marked paid" }
  // Only valid when generationStatus = GENERATED, approvalStatus = APPROVED, paidAt = null.
```

### 2.4 Invoices — listing and resource actions

```
GET /admin/invoices?resourceId=&status=      (admin, filterable)
GET /resource/invoices                        (resource — always scoped to session)
Response 200: [{
  id, invoiceNo, projectName, batch, amount, invoiceDate,
  generationStatus, amountConfirmationStatus, approvalStatus,
  driveDocUrl, declineReason, actionedAt
}]
  // driveDocUrl is withheld (null) to the resource until amountConfirmationStatus = CONFIRMED
  // (§0.9) — the document already exists by then, just not exposed yet. Admin's view is not
  // gated this way.

POST /resource/invoices/:invoiceId/confirm-amount   // gate 1
Response 200: { invoiceId, amountConfirmationStatus: "CONFIRMED" }
Response 403: { error: "Not your invoice" }

POST /resource/invoices/:invoiceId/reject-amount    // gate 1
Request: { reason?: string }
Response 200: { invoiceId, amountConfirmationStatus: "REJECTED" }
Response 403: { error: "Not your invoice" }
  // fires AMOUNT_REJECTED to admin (§0.9); row held until admin reprocesses (§2.3)

POST /resource/invoices/:invoiceId/approve          // gate 2
Response 200: { invoiceId, approvalStatus: "APPROVED", actionedAt }
Response 403: { error: "Not your invoice" }   // ownership check: invoice.resourceId !== session.resourceId
Response 403: { error: "Confirm your payout amount first" }   // amountConfirmationStatus != CONFIRMED

POST /resource/invoices/:invoiceId/decline          // gate 2
Request: { reason?: string }
Response 200: { invoiceId, approvalStatus: "DECLINED", actionedAt }
Response 403: { error: "Not your invoice" }
Response 403: { error: "Confirm your payout amount first" }   // amountConfirmationStatus != CONFIRMED
```

### 2.5 Resources (Admin)

```
GET /admin/resources
Response 200: [{ id, name, email, totalInvoices, pending, approved, declined, pendingDocuments: boolean }]

GET /admin/resources/:id
Response 200: {
  id, name, email, address, contactNo, pan,
  beneficiaryName, accountNo, bankName, ifsc,
  bankLocked, onboardingCompleted,
  accountActivated: boolean,        // added per §0.25 — true once passwordHash is set
  inviteExpiresAt: string | null,   // added per §0.25 — null if never invited or already accepted
  invoices: [...],   // same shape as 2.4
  documents: [...]   // same shape as 2.6
}

POST /admin/resources/:id/unlock-bank
Response 200: { resourceId, unlockedAt }

POST /admin/resources/:id/send-invite   // added per §0.25 — manual, admin-triggered (user-confirmed:
  // not automatic on sync, since real sheet data can be messy/duplicated)
Response 200: { resourceId, inviteExpiresAt: string }
  // Generates a fresh token (invalidating any prior unused one — this doubles as "resend"),
  // sets a 7-day expiry, fires INVITE_SENT to the resource's email with the accept-invite link.
```

### 2.6 Profile & Onboarding (Resource)

```
GET /resource/profile
Response 200: { name, email, address, contactNo, pan, beneficiaryName, accountNo, bankName, ifsc, bankLocked, onboardingCompleted }
  // onboardingCompleted added per §0.21 — lets the frontend redirect a freshly
  // logged-in resource to /onboarding vs /invoices; not exposed anywhere else
  // to the resource themselves (GET /admin/resources/:id has it, admin-side only)

POST /resource/onboarding   (one-time; rejected if onboardingCompleted already true)
Request: { address, contactNo, pan, beneficiaryName, accountNo, bankName, ifsc }
Response 200: { onboardingCompleted: true, bankLocked: true }
  // Also re-checks this resource's FLAGGED invoices and auto-queues any that
  // are now ready (§0.28) — added per §0.23's original gate, user-requested.

PUT /resource/profile
Request: { address?, contactNo?, pan?, beneficiaryName?, accountNo?, bankName?, ifsc? }
Response 200: { updated fields..., bankLocked: true }
Response 403: { error: "Details are locked. Ask your admin to unlock them." }
  // allowed only if an open BankUnlockLog exists for this resource (unlockedAt set, editedAt null)
```

### 2.7 Documents

```
POST /resource/documents/:type       (multipart/form-data; type = aadhaar|pan|photo|bank_proof|nda)
Response 200: { docType, status: "PENDING_REVIEW", uploadedAt }

GET /resource/documents
GET /admin/resources/:id/documents
Response 200: [{ id, docType, fileUrl, status, rejectionReason, reviewedAt, uploadedAt }]
  // id added per §0.22 — the admin verify/reject endpoints below need a
  // specific Document id, which nothing in this list previously exposed

POST /admin/documents/:id/verify
Response 200: { id, status: "VERIFIED", reviewedAt }
  // Also re-checks this resource's FLAGGED invoices and auto-queues any that
  // are now ready (§0.28). /reject has no such effect — rejecting can only
  // make a resource less ready, never more.

POST /admin/documents/:id/reject
Request: { reason: string }
Response 200: { id, status: "REJECTED", reviewedAt, rejectionReason }
```

---

## 3. Duplicate & Stale-Amount Detection — query logic

Run against the selected `sheetRowIds` before creating any `Invoice` rows.

**Hard flag — same resource + project + batch already invoiced:**
```sql
SELECT 1 FROM "Invoice" i
JOIN "SheetRow" sr ON i."sheetRowId" = sr.id
WHERE sr."resourceEmail" = :resourceEmail
  AND sr."projectName" = :projectName
  AND sr."batch" = :batch
  AND i."generationStatus" != 'FAILED'
```

**Soft flag — same resource + same amount within 90 days:**
```sql
SELECT "invoiceNo", "createdAt" FROM "Invoice"
WHERE "resourceId" = :resourceId
  AND "amount" = :amount
  AND "createdAt" >= NOW() - INTERVAL '90 days'
  AND "generationStatus" != 'FAILED'
```

Both checks run per-row in the selected batch; a row can trigger either or both. Both are now hard-blocking per the earlier decision — the row's `Invoice` is created with `generationStatus = FLAGGED` and no job is enqueued until `/admin/invoices/:invoiceId/acknowledge-flag` is called.

---

## 4. Google Docs API — template fill

Requires the invoice template to contain literal placeholder tokens (not yet in the uploaded template — **action item**: create a copy of the current template with these tokens in place of the static labels).

```json
{
  "requests": [
    { "replaceAllText": { "containsText": { "text": "{{RESOURCE_NAME}}", "matchCase": true }, "replaceText": "Ritika Garg" } },
    { "replaceAllText": { "containsText": { "text": "{{ADDRESS}}", "matchCase": true }, "replaceText": "..." } },
    { "replaceAllText": { "containsText": { "text": "{{CONTACT_NO}}", "matchCase": true }, "replaceText": "..." } },
    { "replaceAllText": { "containsText": { "text": "{{EMAIL}}", "matchCase": true }, "replaceText": "..." } },
    { "replaceAllText": { "containsText": { "text": "{{PAN}}", "matchCase": true }, "replaceText": "..." } },
    { "replaceAllText": { "containsText": { "text": "{{INVOICE_NO}}", "matchCase": true }, "replaceText": "INV-0001" } },
    { "replaceAllText": { "containsText": { "text": "{{INVOICE_DATE}}", "matchCase": true }, "replaceText": "24 Aug 2026" } },
    { "replaceAllText": { "containsText": { "text": "{{PROJECT_NAME}}", "matchCase": true }, "replaceText": "..." } },
    { "replaceAllText": { "containsText": { "text": "{{HOURS}}", "matchCase": true }, "replaceText": "..." } },
    { "replaceAllText": { "containsText": { "text": "{{RATE}}", "matchCase": true }, "replaceText": "..." } },
    { "replaceAllText": { "containsText": { "text": "{{AMOUNT}}", "matchCase": true }, "replaceText": "..." } },
    { "replaceAllText": { "containsText": { "text": "{{AMOUNT_IN_WORDS}}", "matchCase": true }, "replaceText": "..." } },
    { "replaceAllText": { "containsText": { "text": "{{BENEFICIARY_NAME}}", "matchCase": true }, "replaceText": "..." } },
    { "replaceAllText": { "containsText": { "text": "{{ACCOUNT_NO}}", "matchCase": true }, "replaceText": "..." } },
    { "replaceAllText": { "containsText": { "text": "{{BANK_NAME}}", "matchCase": true }, "replaceText": "..." } },
    { "replaceAllText": { "containsText": { "text": "{{IFSC}}", "matchCase": true }, "replaceText": "..." } }
  ]
}
```
This request is naturally idempotent — a retry that re-runs after a partial failure simply finds no matching token for placeholders already replaced (no-op) and fills whatever's left.

---

## 5. Job Queue — worker pseudocode

```
async function processInvoiceJob({ invoiceId }) {
  const invoice = await db.invoice.findUnique(invoiceId, { include: sheetRow, resource })
  await db.invoice.update(invoiceId, { generationStatus: 'PROCESSING' })

  if (!invoice.driveFileId) {
    const fileId = await driveApi.copyTemplate(TEMPLATE_ID, TARGET_FOLDER_ID)
    await db.invoice.update(invoiceId, { driveFileId: fileId })  // persisted before continuing
  }

  await docsApi.batchUpdate(invoice.driveFileId, buildPlaceholderRequests(invoice))
  await driveApi.shareWithEmail(invoice.driveFileId, invoice.resource.email)

  await db.invoice.update(invoiceId, {
    generationStatus: 'GENERATED',
    approvalStatus: 'PENDING',
    driveDocUrl: buildDriveUrl(invoice.driveFileId),
  })

  await notify('PAYOUT_GENERATED', invoice.resource.email, invoiceId)  // renamed, §0.9 — no document link yet
}
```
On unhandled error: BullMQ retries (configured: 3 attempts, exponential backoff). After exhausting retries, catch and set `generationStatus = 'FAILED'`, `errorMessage`.

---

## 6. Still open (unchanged from HLD)

- ~~`[TBD: invite flow]`~~ — resolved, see §0.25.
- ~~`[TBD: payout reconciliation]`~~ — resolved, see §0.26 (note 10's original deferral).
- Legal/compliance sign-off on Aadhaar/PAN retention.
- Google Cloud service account not yet created.
- Invoice template needs placeholder tokens inserted (§4).
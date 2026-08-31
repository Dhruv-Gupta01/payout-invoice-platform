# Build Plan: Resource Payout & Invoice Automation Platform

**Companion docs:** `HLD-payout-invoice-platform.md`, `LLD-payout-invoice-platform.md`
**Approach:** Strict TDD — for every slice below, write the failing test first against the exact contract in the LLD, then the minimal code to pass it, then refactor. Nothing gets implemented that isn't specified in the LLD; if something's missing from the doc, stop and update the doc first.

Check items off as they're completed. Each phase assumes the ones above it are done and passing.

---

## Phase 0 — Scaffold

- [x] Repo initialized, Express + TypeScript set up
- [x] Prisma installed, schema from LLD §1 applied to a local/test Postgres
- [x] Test runner configured (Jest or Vitest) — Vitest
- [x] One trivial test proving the DB connection + a model round-trip works
- [x] `.env.example` created (DATABASE_URL, session secret, placeholders for Google/Resend/Redis creds to come later)

## Phase 1 — Auth

- [x] Test: login with correct credentials returns session + user shape (LLD §2.1) — admin and resource
- [x] Test: login with wrong credentials returns 401
- [x] Test: `/admin/*` route rejects a resource-role session (403)
- [x] Test: `/resource/*` route rejects an admin-role session (403)
- [x] Test: `GET /auth/me` returns the current session's user — admin only so far (see note below)
- [x] Implement: password hashing (bcryptjs — see Phase 0 substitution note), session middleware, role-check middleware
- [x] **Note:** `passwordHash` seeding depends on the invite flow decision — use a manual/seeded value for now, revisit once that's settled — done, tests seed `passwordHash` directly with bcryptjs

## Phase 2 — Sync

- [x] Test: syncing a new sheet row creates a `SheetRow` + `Resource` (if email doesn't exist yet)
- [x] Test: **syncing the same row twice updates it in place — does not duplicate, does not orphan an existing Invoice's FK** (this is the natural-key upsert bug caught in the LLD — this test is the whole point)
- [x] Test: a row missing/with invalid email is skipped and reported, doesn't fail the whole sync — plus email normalization (lowercase+trim), same LLD §2.2 paragraph
- [x] Test: a row present before but absent from a later sync is marked `removedFromSheet = true`, not deleted
- [x] Implement: sync endpoint against a fake `SheetsProvider` (real Google Sheets client comes later)

## Phase 3 — Invoice Generation

- [x] Test: hard-flag query correctly identifies same resource+project+batch already invoiced (LLD §3)
- [x] Test: soft-flag query correctly identifies same resource+amount within 90 days
- [x] Test: a row matching neither check proceeds as `clean`
- [x] Test: `POST /admin/invoices/generate` creates `Invoice` rows in `FLAGGED` vs `QUEUED` correctly per the above
- [x] Test: `POST /admin/invoices/:id/acknowledge-flag` transitions FLAGGED → QUEUED
- [x] Test (worker, against fake `DocsProvider`): successful run sets `driveFileId`, `driveDocUrl`, `generationStatus = GENERATED`, `approvalStatus = PENDING`
- [x] Test (worker): if `fillTemplate` throws after `copyTemplate` succeeded, a retry does **not** re-copy — resumes using the already-persisted `driveFileId`
- [x] Test (worker): after retries exhausted, `generationStatus = FAILED` with `errorMessage` set
- [x] Implement: generation endpoint, flag-check logic, worker function against the fake provider
- [ ] **Not covered by this phase's checklist, so not implemented — flagging:** `GET /admin/invoices/status/:batchId` and `POST /admin/invoices/:invoiceId/retry` (both LLD §2.3) have no driving test here. Left for a follow-up phase/test.
- [x] **Superseded by Phase 6.6 (LLD §0.9):** the worker's final `notify(...)` call is `INVOICE_GENERATED` as built here — Phase 6.6 renames it to `PAYOUT_GENERATED` and adds the amount-confirmation gate in front of what this phase generates. Done in Phase 6.6.

## Phase 4 — Notifications

**Scope note (flagged, user-confirmed):** of the six events, only "Invoice generated" has a trigger point that exists yet. "Document verified/rejected" depend on Phase 5 endpoints, "Bank details unlocked" depends on a Phase 6 endpoint — building those early would break strict phase order, so this phase builds the notifier (`EmailProvider` interface + fake, `NotificationLog` writing, failure handling) generically and wires+tests only the one trigger point that exists today. The other two get a reminder line in Phases 5 and 6 below. **"Invoice declined" has no scheduled phase at all** — `POST /resource/invoices/:invoiceId/decline` (LLD §2.4), and in fact the entire §2.4 "Invoices — listing and resource actions" endpoint set (`GET /admin/invoices`, `GET /resource/invoices`, approve, decline) isn't in any phase of this build plan. Needs a decision on where it belongs (candidates: fold into Phase 3, or a new phase) — not decided here.

- [x] Test: "Invoice generated" fires against a fake `EmailProvider` at its correct trigger point (end of successful generation job, LLD §5), with correct recipient (LLD/HLD §7)
- [ ] Test: the other five events — blocked on their trigger endpoints (see scope note above); to be added alongside each endpoint in its own phase
- [x] Test: a failed send is logged as `NotificationStatus.FAILED`, doesn't crash the triggering action
- [x] Implement: notifier (`EmailProvider` interface + fake, `NotificationLog` writing) wired into the worker's successful-generation step
- [x] **Superseded by Phase 6.6 (LLD §0.9):** this test asserts `INVOICE_GENERATED` fires — Phase 6.6 updates it to assert `PAYOUT_GENERATED` instead (same trigger point, renamed event, no document link). Done in Phase 6.6.

## Phase 5 — Documents & Onboarding

**Scope correction (flagged, user-confirmed):** this item originally read "creates 5 Document rows as PENDING_REVIEW" as part of onboarding, following HLD §5.3's one-action narrative. But LLD §2.6's onboarding request has no document fields, LLD §2.7 defines document upload as a separate per-type multipart endpoint, and `Document.fileUrl` is required — onboarding literally cannot create real Document rows without file content it never receives. Corrected: onboarding sets profile/bank fields only; the 5 Document rows are created by 5 separate `POST /resource/documents/:type` calls.

- [x] Test: `POST /resource/onboarding` sets `onboardingCompleted = true`, `bankLocked = true` (profile/bank fields only — see scope correction above)
- [x] Test: onboarding rejected if already completed
- [x] Test: `POST /resource/documents/:type` creates a `Document` row as `PENDING_REVIEW`
- [x] Test: `POST /admin/documents/:id/verify` and `/reject` update status, reviewer, timestamp correctly
- [x] **Reminder from Phase 4:** wire+test the `DOCUMENT_VERIFIED`/`DOCUMENT_REJECTED` notifications (to the resource) at these two trigger points, using the notifier built in Phase 4
- [x] Test: re-upload after rejection resets status to `PENDING_REVIEW` and fires the re-upload notification to admin — recipient chosen as the rejecting admin (`reviewedById`); LLD/HLD don't specify which admin when there are several, flagged as an assumption
- [x] Implement: onboarding + document endpoints, against a fake file-storage provider (Drive)

## Phase 6 — Bank Lock/Unlock

- [x] Test: `PUT /resource/profile` rejected (403) when no open `BankUnlockLog` exists
- [x] Test: `POST /admin/resources/:id/unlock-bank` creates a `BankUnlockLog` row and allows exactly one subsequent edit
- [x] **Reminder from Phase 4:** wire+test the `BANK_UNLOCKED` notification (to the resource) at this trigger point, using the notifier built in Phase 4
- [x] Test: after that edit, `bankLocked = true` again, `editedAt`/`reLockedAt` stamped, further edits rejected again
- [x] Implement: unlock endpoint + profile-edit guard

## Phase 6.5 — Invoice Listing & Resource Actions

**Added (flagged, user-confirmed):** these LLD §2.3/§2.4 endpoints were never assigned to any phase — surfaced at the end of Phase 3 (status/retry) and Phase 6 (listing/approve/decline), addressed together here before Phase 7.

- [x] Test: `GET /admin/invoices` returns invoices in the LLD §2.4 shape, filterable by `resourceId` and `status` (interpreted as `generationStatus` — LLD's single unqualified `status` param predates the generationStatus/approvalStatus split in §0.2, ambiguous which one it means; flagging the interpretation)
- [x] Test: `GET /resource/invoices` returns only the session resource's own invoices, same shape
- [x] Test: `POST /resource/invoices/:invoiceId/approve` sets `approvalStatus = APPROVED`, `actionedAt`; 403 `{ error: "Not your invoice" }` if the invoice isn't the session resource's own
- [x] Test: `POST /resource/invoices/:invoiceId/decline` sets `approvalStatus = DECLINED`, `actionedAt`, same ownership check; fires `INVOICE_DECLINED` to `ADMIN_NOTIFICATION_EMAIL` (LLD §0.7)
- [x] Test: `GET /admin/invoices/status/:batchId` returns `{ batchId, total, counts: { queued, processing, generated, failed, flagged } }`
- [x] Test: `POST /admin/invoices/:invoiceId/retry` — valid only when `generationStatus = FAILED`, transitions back to `QUEUED` and re-enqueues
- [x] Implement: the above five endpoints (six, including `GET /admin/invoices` and `GET /resource/invoices` as separate routes)
- [x] **Superseded by Phase 6.6 (LLD §0.9):** approve/decline built here become gate 2, only actionable once a new gate 1 (amount confirmation) passes — their tests need a `confirm-amount` call added to setup, plus a new guard test. Done in Phase 6.6.

## Phase 6.6 — Payout Confirmation Gate (rework)

**Added (flagged, user-confirmed — LLD §0.9):** correction to the already-built generate → notify → approve/decline flow. The resource now confirms the computed *amount* before ever seeing the invoice document — a new gate 1 in front of the existing approve/decline (now gate 2). This touches code from Phase 3 (worker's `notify` call), Phase 4 (the `INVOICE_GENERATED` test), and Phase 6.5 (approve/decline) — not just new additions. Each item below still gets its failing test first, per the usual rule, including for the *changed* behavior of already-passing tests.

- [x] Migration: `AmountConfirmationStatus` enum (`PENDING`/`CONFIRMED`/`REJECTED`); `Invoice.amountConfirmationStatus` (default `PENDING`), `amountConfirmedAt`, `amountRejectionReason`; `NotificationEvent.INVOICE_GENERATED` renamed `PAYOUT_GENERATED`, `AMOUNT_REJECTED` added — applied via hand-written SQL migration since `prisma migrate dev` refuses to run non-interactively when an enum value is removed; verified 0 rows used the old value on both DBs first
- [x] Test (update existing): worker's successful-generation notification fires `PAYOUT_GENERATED`, not `INVOICE_GENERATED` (Phase 4's test needs updating, not just a new one)
- [x] Test: `GET /resource/invoices` withholds `driveDocUrl` (null) while `amountConfirmationStatus = PENDING`, exposes it once `CONFIRMED`
- [x] Test: `POST /resource/invoices/:invoiceId/confirm-amount` sets `amountConfirmationStatus = CONFIRMED`, `amountConfirmedAt`; 403 ownership check
- [x] Test: `POST /resource/invoices/:invoiceId/reject-amount` sets `REJECTED`, fires `AMOUNT_REJECTED` to `ADMIN_NOTIFICATION_EMAIL`; 403 ownership check
- [x] Test (update existing): `POST /resource/invoices/:invoiceId/approve` and `/decline` (gate 2) now 403 with `{ error: "Confirm your payout amount first" }` when `amountConfirmationStatus != CONFIRMED` — Phase 6.5's tests updated: fixtures now default to `amountConfirmationStatus: CONFIRMED` (gate 1 already passed) plus a new negative test per endpoint for the guard itself
- [x] Test: `POST /admin/invoices/:invoiceId/reprocess` — only valid when `amountConfirmationStatus = REJECTED`; re-derives `amount` from the current `SheetRow`, resets `amountConfirmationStatus → PENDING` and `generationStatus → QUEUED`, re-enqueues, reuses existing `driveFileId`
- [x] Implement: the above, wired into the existing worker/router code rather than built alongside it as separate modules

## Phase 7 — Queue Wiring (real Redis/BullMQ, not a fake)

**Note:** Redis added to docker-compose.yml alongside Postgres, required for these tests to run.

- [x] Test (integration, against a real Docker-container Redis): a job enqueued by `RealJobQueue` is actually picked up and processed by a real BullMQ `Worker`
- [x] Test: concurrency settings don't exceed configured thresholds under a batch of jobs (rate limiter is configured alongside concurrency but not separately timing-verified — flagged, to avoid a wall-clock-flaky test)
- [x] Test (added — untested implementation otherwise): real BullMQ retry exhaustion marks the invoice `FAILED` via the worker's `'failed'` event handler, without re-copying the template
- [x] Implement: `RealJobQueue` (BullMQ `Queue`) + `startInvoiceWorker` (BullMQ `Worker`), swapped into `src/index.ts` in place of `FakeJobQueue`. Concurrency/rate-limit numbers (`WORKER_CONCURRENCY`, `WORKER_RATE_LIMIT_MAX`, `WORKER_RATE_LIMIT_DURATION_MS`) are placeholder defaults — LLD never specifies real Google API quota numbers, only known once the Phase 8 service account exists

## Phase 8 — Real external providers

**Progress note:** real Google credentials are live and verified (auth + Drive + Sheets access all confirmed against the real account, not just code review). Real Resend key still pending. Header aliases and numeric parsing in `RealSheetsProvider` were checked and fixed against the actual sheet (LLD §0.15–16) — this is no longer a guess. Three implementation decisions were made without a pause (LLD §0.11–§0.14) rather than blocking further — flagged there, not asked about individually.

- [x] Google Cloud service account created, Sheets/Docs/Drive APIs enabled, Sheet + Drive folder + `GOOGLE_KYC_FOLDER_ID` shared with it — verified working via a real read-only auth check (all four resources reachable)
- [x] Real `SheetsProvider` (`RealSheetsProvider`) — verified against the real sheet (27 real rows fetched and parsed correctly after fixing header aliases + numeric parsing, LLD §0.15–16), `DocsProvider` (`RealDocsProvider`), `DriveProvider` (`RealDriveProvider`, LLD §0.13–14) implemented against the actual Google APIs, swapped into `src/index.ts` behind the same interfaces used in tests
- [x] Real `EmailProvider` (`RealEmailProvider`) implemented against Resend, draft copy for all seven events in `emailTemplates.ts` (LLD §0.12) — needs your review, not final; still needs `RESEND_API_KEY`/`RESEND_FROM_EMAIL` to actually send
- [x] **Decided, user-confirmed:** using Resend's shared test domain (`onboarding@resend.dev`) for now, not a verified own-domain address — deliberately deferred, not an oversight. Real limitation: that address can only deliver to the Resend account's own signup email, not arbitrary resource inboxes. **Must switch to a verified domain before real resources get real notifications** — revisit before Phase 9/production
- [x] Resend key verified working — real send confirmed with user permission (one test email, `onboarding@resend.dev` → the user's own Resend signup address, real Resend email id returned)
- [x] `{{AMOUNT_IN_WORDS}}` conversion resolved — `to-words`, en-IN locale (LLD §0.11), wired into the worker's real placeholder payload (`buildPlaceholderRequests`, LLD §4) replacing the `[]` TODO from Phase 3. Caught and fixed a related gap while doing this: `Invoice.invoiceDate` was never actually being set anywhere — would have left `{{INVOICE_DATE}}` blank on a real invoice
- [ ] **Blocking discovery, not a code gap (LLD §0.17):** every row in the real sheet has an empty `Email` column — sync's existing (correct, tested-since-Phase-2) skip-on-missing-email behavior would skip all 27 real rows. Needs real emails in the sheet before sync can be trusted with real data — surfaced to the user, not worked around
- [x] Invoice template updated with placeholder tokens (LLD §4) — the user edited the sample invoice directly (I mapped out where each of the 16 tokens should go and flagged that a scripted edit was risky here — several dummy values were identical text, e.g. `"xxxxxx"` for both PAN and IFSC, which a global find-replace would have corrupted; doing it by hand in the Docs editor sidestepped that entirely). Verified programmatically afterward: all 16 tokens present, exact case match, no typos, no duplicates. Extra table rows (2–5) removed too, per HLD's one-row-per-invoice design
- [x] Manual smoke test: one real end-to-end sync → generate → approve, against real Google APIs — **complete.** Sync: 28 rows processed, 1 new resource, 27 correctly skipped for missing email. Generate: hit "storage quota exceeded" on the first real attempt (service accounts have 0 personal Drive quota, LLD §0.18) — the target folders live under a personal Gmail account so the standard Shared Drive fix wasn't available; resolved instead with an OAuth-as-real-user fallback (`GOOGLE_OAUTH_CLIENT_ID`/`_SECRET`/`_REFRESH_TOKEN`, one-time interactive consent) — free, no Workspace needed. Retried: real Drive copy + real Docs fill succeeded, all 16 placeholders correct including `{{AMOUNT_IN_WORDS}}`, real `PAYOUT_GENERATED` email sent. Gate 1 confirm-amount → `driveDocUrl` correctly hidden before / shown after (LLD §0.9 proven for real). Gate 2 approve → `APPROVED`. **Phase 8 is done.**

## Phase 9 — Frontend Integration

The Lovable-exported frontend (TanStack Start + React) was brought into the repo as `frontend/` (monorepo, per user preference). Before wiring any screen, audited it against the actual backend routes/schema and found it doesn't line up cleanly — several screens have no backend support yet, and one (My Invoices) was built against the pre-two-gate spec. Flagged to the user rather than silently deciding; user confirmed the sequencing below.

**Backend gaps found during the audit (fixed test-first before frontend wiring):**
- [x] `GET /auth/me` was admin-only (resource sessions got 401) despite LLD §2.1 specifying it generically — fixed test-first (`tests/auth.test.ts`); a resource session now round-trips `{ id, email, name, role: "resource" }` same as admin
- [x] `GET /admin/resources` + `GET /admin/resources/:id` built (LLD §2.5, was deferred) — `src/admin/resourceListingService.ts`, `tests/resourceListing.test.ts`. Flagged and documented an assumption the LLD doesn't resolve: the `{pending, approved, declined}` summary buckets don't map 1:1 onto the two-gate model, so `declined` counts `approvalStatus = DECLINED` OR `amountConfirmationStatus = REJECTED` (resource said no at either gate), `approved` counts `approvalStatus = APPROVED`, `pending` is everything else (not yet generated, gate 1 pending, gate 2 pending). `pendingDocuments` = any `Document` with status `PENDING_REVIEW`.
- [x] **New LLD addition, user-confirmed:** `GET /admin/sheet-rows` (LLD §2.3/§0.20) — no endpoint had ever listed `SheetRow`s at all, despite §2.3 assuming the client already has a list to select a row-range from. Flagged to the user before building (not a "deferred" case like the others — genuinely missing from the spec); confirmed, added to the LLD, then built test-first. `src/admin/sheetRowListingService.ts`, `tests/sheetRowListing.test.ts`. Excludes `removedFromSheet` rows; `invoiceId`/`generationStatus` are `null` for rows not yet generated (the Dashboard's "Not Generated" state).
- [x] `GET /resource/profile` built (LLD §2.6, was deferred) — `src/resource/profileService.ts` (`getProfile`), `tests/resourceProfile.test.ts`
- [x] `GET /resource/documents` + `GET /admin/resources/:id/documents` built (LLD §2.7) — `listDocuments` in `src/resource/documentService.ts`, shared by both routes; extended `tests/documents.test.ts`
- [ ] Document type ID mismatch still to reconcile when wiring the frontend: it uses `aadhaar/pan/photo/passbook/nda` (onboarding oddly uses `panCard` instead of `pan`), backend enum/URL param is `aadhaar/pan/photo/bank_proof/nda` → `AADHAAR/PAN/PHOTO/BANK_PROOF/NDA`

**Frontend screens, in wiring order:**
- [x] Login (`frontend/src/routes/login.tsx`) → real `POST /api/auth/login`; resource redirect (`/onboarding` vs `/invoices`) decided by the new `GET /resource/profile` `onboardingCompleted` field (LLD §0.21, added and confirmed above)
- [x] My Invoices (`frontend/src/routes/invoices.tsx`) — reworked for the real two-gate flow (gate 1: confirm/reject amount, no doc link → gate 2: doc visible, approve/decline, per LLD §0.9), using `@tanstack/react-query` for fetch/mutations. Verified real end-to-end in the browser against the real backend (not just fakes): login → redirect → all 5 gate states rendered correctly (pending/rejected/gate-2-pending/approved/declined) → confirm-amount flips gate 1→2 live → approve flips to terminal, all through the dev proxy with the session cookie intact. Flagged and documented one assumption: the resource-facing list is filtered to `generationStatus = GENERATED` client-side, since that's the resource's first signal an invoice exists at all (`PAYOUT_GENERATED` email) — an ungenerated row already defaults to `amountConfirmationStatus = PENDING`, which would otherwise wrongly show gate 1 UI before the resource was ever notified.
- [x] Dev wiring: `frontend/vite.config.ts` proxies `/api/*` to the Express backend (port 3001 in this environment — 3000 is occupied by an unrelated container) so the session cookie round-trips without CORS; `frontend/src/lib/api.ts` is the shared fetch wrapper (credentials included, typed, throws `ApiError` with the backend's `{ error }` message)
- [x] Dashboard (`frontend/src/routes/index.tsx` / `dashboard.tsx`) → wired to `GET /admin/sheet-rows`, `POST /admin/sync`, `POST /admin/invoices/generate`, `POST /admin/invoices/:id/acknowledge-flag`, and polls `GET /admin/invoices/status/:batchId` (2s interval) until a batch clears QUEUED/PROCESSING, refreshing the row list live. Row Status column shows `generationStatus` only (Not Generated/Queued/Processing/Generated/Failed/Flagged) — this endpoint doesn't carry the two-gate fields, which belong to the Resources/invoices views. "Start row/End row" is a pure UI convenience over the displayed array's position (LLD §0 note 3 — no persisted row-number field exists). Verified real end-to-end (fake providers, real Postgres/Redis/BullMQ): synced-empty→removedFromSheet handling, generate produced both a clean row (auto-flipped Not Generated→Generated via polling) and a hard-flag duplicate row (flagged banner with reason, Acknowledge & queue flipped it to Generated too).
- [x] **Incident during Dashboard testing, self-caught and fixed:** triggering a real (empty-result) sync against the live dev DB marked the real Phase 8 smoke-test `SheetRow` (dhruvgupta9191@gmail.com) as `removedFromSheet = true` — correct LLD §2.2 behavior for a row absent from the current sync, but an unintended side effect on real data from a test action. Caught immediately, restored (`removedFromSheet = false`) before continuing.
- [x] Resources list + Resource detail (`frontend/src/routes/resources.index.tsx`, `resources.$id.tsx`) → wired to `GET /admin/resources`/`GET /admin/resources/:id`; bank-unlock replaced the `localStorage`-based `unlockStore.ts` with the real `resource.bankLocked` field + `POST /admin/resources/:id/unlock-bank` (admin's "Unlock" is real; the old mock's "Simulate resource save" button was removed — only the resource's own `PUT /resource/profile`, wired when Profile is done, can re-lock). `DocumentsSection` (`frontend/src/components/ops/DocumentsSection.tsx`) rewritten to take real `documents` + wire `POST /admin/documents/:id/verify`/`reject`, rendering against a fixed 5-type catalog with "Not uploaded" for types the resource hasn't submitted yet. Verified real end-to-end: resource list counts, unlock flow (locked → confirm → unlocked), and document verify all round-tripped correctly against the real backend.
- [x] Profile (`frontend/src/routes/profile.tsx`) → wired to `GET`/`PUT /resource/profile`; `editing` derived from `bankLocked` (same field the admin side reads/flips) rather than a separate flag. `frontend/src/data/unlockStore.ts` (the `localStorage` mock) deleted — no longer referenced anywhere. Verified real end-to-end, both sides of the same round trip: admin unlock (Resources screen) → resource sees "unlocked" banner, edits, saves → flips back to locked, admin's own view reflects it too (same `bankLocked` field).
- [x] Documents (`frontend/src/routes/documents.tsx`) → wired to `GET /resource/documents` + `POST /resource/documents/:type` (real multipart upload — `frontend/src/lib/api.ts` gained an `upload()` helper alongside the JSON one, since the upload endpoint needs `FormData` with no forced `Content-Type`). Reconciled the ID mismatch by driving the UI off a fixed 5-type catalog keyed to the backend's own enum/URL-param spelling (`aadhaar/pan/photo/bank_proof/nda` → `AADHAAR/PAN/PHOTO/BANK_PROOF/NDA`) rather than the frontend's original ad hoc ids. `frontend/src/data/documents.ts` (mock) deleted.
- [x] Onboarding (`frontend/src/routes/onboarding.tsx`) → wired to `POST /resource/onboarding` + `POST /resource/documents/:type` (same upload pattern as Documents — each file uploads immediately on selection rather than being deferred to submit). "Submit and lock" gates on all 7 text fields plus all 5 document types actually present via `GET /resource/documents`.
- [x] Full click-through verified real end-to-end (fake Drive/Docs/Email providers, real Postgres/Redis/BullMQ, dev server on port 3001 — 3000 was occupied by an unrelated container): login (admin + resource, both role branches) → onboarding (fresh resource: fill fields, upload all 5 docs via real multipart, submit, redirected to "complete") → re-login now lands on `/invoices` instead (`onboardingCompleted` flip persisted) → dashboard (sync, generate clean + hard-flagged rows, acknowledge-flag, live polling) → resource confirms/rejects amount (gate 1) → resource approves/declines (gate 2) → admin resource-detail (unlock bank → resource edits/saves in Profile → re-locks, verified from both sides) → admin verifies a document. All test fixtures (`e2e-*` resources/admin) removed afterward; the real Phase 8 smoke-test row confirmed untouched.
- [x] **Incident during Dashboard testing, self-caught and fixed:** see the sheet-row-listing entry above — same incident, documented once.

**Real visual check (Claude in Chrome, real screenshots — not just the internal pane's text/accessibility-tree checks above) surfaced three more real defects, all found live and fixed:**
- [x] **Serious: an uncaught async rejection crashed the entire backend process, not just the one request.** Navigating to a stale/unknown resource id hit `findUniqueOrThrow` unguarded in a route handler; Express 4 doesn't auto-catch a rejected promise from an async handler, so the request hung forever client-side (infinite spinner) *and* the uncaught rejection took down the whole process — every other in-flight request failed too. Reproduced test-first (`tests/resourceListing.test.ts` — confirmed as an actual timeout/unhandled-rejection, not just a clean assertion failure). Fixed with `src/lib/asyncHandler.ts` (wraps a route handler so any rejection reaches Express's error middleware instead of crashing) applied to *every* route across all three routers — not just the one that happened to trip over it — plus a global error-handling middleware in `src/app.ts` that maps Prisma's "record not found" (P2025) to a clean 404 and anything else to a generic 500 (never leaking a stack trace).
- [x] Related UX gap, same root cause: react-query's default 3x-retry-with-backoff was retrying a *definitive* 404 for several seconds before showing the "not found" state — pointless, since retrying can't turn a 404 into a 200. Fixed in `frontend/src/router.tsx`: only retry on non-4xx errors (network failures, 5xx).
- [x] **`AppSidebar`/`ResourceSidebar` hardcoded a display name straight from the Lovable mock** ("Admin User" / "Ritika Garg") — every logged-in user saw someone else's name in the sidebar, regardless of who they actually were. Fixed with a shared `frontend/src/lib/useCurrentUser.ts` hook backed by `GET /auth/me` (the same endpoint fixed at the start of Phase 9), used by both sidebar components.

All three verified live in real Chrome (not just curl/internal-pane): the crash reproduced then stopped occurring, the 404 state now resolves instantly instead of after ~5s, and both sidebars show the real logged-in name. Full suite re-confirmed clean after these fixes: 25 test files, 83 tests, `tsc` clean (backend and frontend).

**Phase 9 status: all 7 screens wired and verified against the real backend, including a real-Chrome visual pass. Remaining, not blocking:** Resend is still on the test domain (pre-existing, tracked above); the `DOCUMENT_REUPLOADED` recipient inconsistency (LLD §0.7) is still unresolved, user's call.

## Phase 9.5 — Generation Readiness & Document Regeneration (post-launch hardening, user-requested)

Surfaced by real usage on real data (Dhruv Gupta's invoice generated before his profile was complete, so address/PAN/bank fields filled blank in the document) — not planned phase work, but urgent enough to fix immediately. LLD §0.23/§0.24.

- [x] **New rule: invoice generation now blocks on resource readiness, checked separately from duplicate/stale-amount detection (LLD §0.23).** `generateInvoices` flags a row (reusing the existing FLAGGED mechanism, §2.3) if its resource hasn't completed onboarding, and independently if any of the 5 required documents (`AADHAAR`/`PAN`/`PHOTO`/`BANK_PROOF`/`NDA`) isn't `VERIFIED` — missing, pending, and rejected all count as "not ready." Unlike duplicate/stale-amount reasons (an admin judgment call, freely overridable), these two are **not**: `acknowledge-flag` now re-checks specifically onboarding+documents at acknowledge time and refuses (400, `ResourceNotReadyError`) if either still fails, regardless of what the admin clicks. New module: `src/admin/resourceReadiness.ts`. Existing acknowledge-flag/generate tests updated to seed a fully "ready" resource where the test's actual concern is duplicate detection, not readiness (`seedReadyResource` helper, `tests/invoiceGeneration.test.ts`) — otherwise every pre-existing fixture would now incidentally also fail the new check.
- [x] **Serious bug found while building the above, not caught by the test suite (only exercises `FakeDocsProvider`): `reprocessInvoice`'s "reuse the same Drive file" design silently failed to update the document.** `buildPlaceholderRequests` (§4) replaces literal `{{TOKEN}}` text — that only works once; a document already fully filled has no tokens left to replace, so a second `batchUpdate` no-ops (Google's API reports success with 0 replacements, doesn't error). Since generation completes before gate 1 can even be rejected, `reprocessInvoice`'s "corrected amount" never actually reached the document. Never caught in Phase 8's real-doc smoke test either (that only covered confirm → approve, not reject → reprocess). **Fixed, user-confirmed:** `reprocessInvoice` now deletes the old Drive file and clears `driveFileId` before re-enqueuing, letting the worker's existing `if (!driveFileId)` guard copy a fresh template — guaranteed-clean tokens. New `DriveProvider.deleteFile` interface method (Fake + Real implementations).
- [x] **New endpoint, user-requested: `POST /admin/invoices/:invoiceId/regenerate-document`** (only valid when `generationStatus = GENERATED`) — re-fills an already-generated invoice's document from *current* resource/sheetRow data, for exactly the Dhruv Gupta scenario. Same delete-old-file-and-copy-fresh approach as the reprocess fix, but runs synchronously (not queued, `src/dependencies.ts` gained a `docsProvider` field so the app itself can call Docs directly) and deliberately leaves `amountConfirmationStatus`/`approvalStatus` untouched and sends no notification — this corrects a document's contents, it isn't a new generation event. `src/worker/driveConfig.ts` extracted (`TEMPLATE_ID`/`TARGET_FOLDER_ID`/`buildDriveUrl`) so both the worker and this new action share one source instead of duplicating the env-var reads.
- [x] Verified: 26 test files, 89 tests (added: `tests/invoiceRegenerateDocument.test.ts`, readiness-gate tests in `tests/invoiceGeneration.test.ts`, updated `tests/invoiceReprocess.test.ts`), `tsc` clean. One `queueIntegration.test.ts` flake during the final run — the live dev server's own BullMQ worker competing on the same Redis queue as the test, the same known cross-contamination pattern hit repeatedly earlier this session; not a regression, confirmed by inspection (test passes in isolation).
- [ ] Not yet done: no frontend UI for `regenerate-document` yet (the Dhruv Gupta case was intentionally left for the user to trigger via a direct API call or future UI work) — flagged here rather than built silently, since Phase 9's frontend screens didn't anticipate this action.

## Phase 9.6 — Logout + Invite Flow (user-requested, resolves the original [TBD: invite flow] deferral)

- [x] **`POST /auth/logout` — specified in the LLD from the start (§2.1) but never actually built.** No backend route, no frontend button anywhere. Surfaced by the user asking "why is there no logout option" during manual testing. Fixed: route destroys the session (idempotent — 204 even with no session), frontend `useLogout` hook + a "Log out" button in both `AppSidebar` and `ResourceSidebar` (icon-only on the resource mobile top bar for space).
- [x] **Invite flow designed and built, LLD §0.25.** Resource-only (admin accounts stay manually seeded, same as always — not a gap, just out of scope for a handful of trusted internal staff). Manual/admin-triggered (user-confirmed over automatic-on-sync — the real sheet has messy/duplicate data, e.g. the same person under different casing per §0.17, so auto-emailing on every new row risked inviting the wrong person off a typo).
  - `Resource.inviteToken` (unique) + `inviteTokenExpiresAt` (7-day validity, flagged as my default) — new migration `20260829125143_invite_flow`, applied to both `payout_dev` and `payout_test`
  - `POST /admin/resources/:id/send-invite` — generates a fresh token (overwriting any prior unused one — that's how "resend" works, no separate endpoint), fires new `INVITE_SENT` notification event
  - `POST /auth/accept-invite` — verifies the token, sets the password, clears the token, logs the resource in immediately (same response shape as login, no separate login step)
  - `GET /admin/resources/:id` gained `accountActivated`/`inviteExpiresAt` so the admin UI can show invite status
  - `buildEmailContent`/`RealEmailProvider` extended with a dedicated `inviteUrl` parameter (structurally different from every other event's `ref` — a clickable link, not a label) — new `FRONTEND_BASE_URL` env var (defaults to the local dev frontend) builds the `/accept-invite?token=...` link
  - Frontend: new public route `frontend/src/routes/accept-invite.tsx` (set-password form, no auth required), "Send invite"/"Resend invite" button + status badge on the admin Resource-detail page
  - Same Resend test-domain limitation as every other notification — invite emails won't reach a real resource until the domain is verified
- [x] Verified: 27 test files, 97 tests (added `tests/inviteFlow.test.ts`, logout tests in `tests/auth.test.ts`, invite-status test in `tests/resourceListing.test.ts`), `tsc` clean (backend and frontend). Not yet verified live against the real backend (would send a real invite email) — left for the user to trigger themselves when ready, flagged rather than done silently.

## Phase 10 — Security & Compliance Review (before real documents touch the system)

- [ ] Legal/compliance sign-off on Aadhaar/PAN retention obtained
- [ ] Service account scope double-checked (only the intended Sheet + folder)
- [ ] Ownership checks re-verified on every resource-facing action (no IDOR)
- [ ] Aadhaar masking applied wherever displayed in the UI
- [x] ~~Invite flow finalized and implemented~~ — done, Phase 9.6 above

## Phase 11 — Payout Reconciliation

**Decided — LLD §0.26.** A real bank sample (NEFT CSV: `Sr. No, Txn Type, Credit Account No., Credit Account Name, IFSC, Amount, Narration`) was reviewed against the six blocking decisions:

- [x] CSV column format — reviewed against a real bank sample. No invoice number, no email; `Narration` is always generic (confirmed by user), so it carries no matching signal.
- [x] Matching key — `Credit Account No.` + `IFSC` → `Resource` (`Resource.accountNo`/`ifsc`), then `Amount` → which eligible invoice.
- [x] Eligible invoice states — `generationStatus = GENERATED`, `approvalStatus = APPROVED`, `paidAt = null` only.
- [x] Notification recipient — `ADMIN_NOTIFICATION_EMAIL` (same pattern as `INVOICE_DECLINED`/`AMOUNT_REJECTED`), not the resource.
- [x] Audit trail — stateless; no separate run record, only `Invoice.paidAt` + the existing `NotificationLog` (used to dedupe repeat `INVOICE_NOT_PAID` emails across runs).
- [x] Ambiguous match (same resource, multiple eligible invoices at the same amount) — not auto-matched; reported in the response, resolved manually via `POST /admin/invoices/:invoiceId/mark-paid`.
- [x] Unrecognized rows (no matching resource, or resource found but no matching invoice amount) — reported back in the response, not silently dropped, no notification.
- [x] Trigger — manual admin upload, `POST /admin/reconciliation` (multipart CSV, `multer` memory storage — same pattern as document upload). CSV only for now (`csv-parse`); Excel not requested.

Build, test-first per LLD §0.26 / §2.3:

- [x] Schema: `Invoice.paidAt DateTime?`, `NotificationEvent.INVOICE_NOT_PAID` — migrated to `payout_dev`/`payout_test`.
- [x] `src/admin/reconciliationService.ts` — CSV parsing (header-name matching, comma-thousands amount parsing via `parseLeadingNumber`), resource/invoice matching (unambiguous / ambiguous / not-paid / unrecognized), `markInvoicePaid`.
- [x] `POST /admin/reconciliation`, `POST /admin/invoices/:invoiceId/mark-paid` — `src/admin/router.ts`.
- [x] `emailTemplates.ts` + `RealEmailProvider.ts` — `INVOICE_NOT_PAID` case, added to `INVOICE_EVENTS`.
- [x] Tests: parsing, all four match outcomes, notification dedup across repeated runs, `mark-paid` endpoint (including 400 for an ineligible invoice). 10 tests, `tests/reconciliation.test.ts`.
- [x] Frontend UI — `/reconciliation` page (LLD §0.27): upload CSV, four result buckets, "Mark paid" per ambiguous candidate.

## Phase 9.8 — Live fixes found manually testing Phase 9.5/11 (auto-clear, worker crash, gate-2 recovery)

Three real issues surfaced testing against the real backend/DB, none previously specified:

- [x] **Auto-clear FLAGGED invoices (LLD §0.28), user-requested.** `verifyDocument`/`completeOnboarding` never re-checked a resource's `FLAGGED` invoices when the blocking condition cleared — stuck until a manual `acknowledge-flag` click, even once actually ready. Fixed with `autoClearReadyFlags`, narrow to readiness-only flags (leaves duplicate/stale-amount flags for explicit human review, as before). `tests/autoClearFlags.test.ts`, 4 tests.
- [x] **Worker crash on a stale job (real bug, not LLD-specified).** `realWorkerProcess.ts`'s `'failed'` handler had an unguarded `prisma.invoice.update` — a leftover job pointing at a since-deleted invoice threw an unhandled rejection that crashed the *entire* backend process, same class of bug as the earlier unguarded-route crash (`asyncHandler.ts`). Fixed with try/catch + log. Regression test added to `tests/queueIntegration.test.ts` (worker stays alive and keeps processing after the doomed job).
- [x] **Gate-2 decline had no recovery path (LLD §0.29), user-requested.** `POST /admin/invoices/:invoiceId/reopen` — resets `approvalStatus` to `PENDING` only (not `amountConfirmationStatus`, not the document — call `regenerate-document` first if needed), notifies the resource via new `INVOICE_REOPENED` event.

---

*Update this file as phases complete or as scope changes — it should stay in sync with actual progress, not just the plan.*
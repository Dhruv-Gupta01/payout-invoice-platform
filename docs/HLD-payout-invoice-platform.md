# High-Level Design: Resource Payout & Invoice Automation Platform

**Organization:** Biz-Tech Analytics Private Limited
**Status:** Draft v1 — architecture finalized, implementation not started
**Owner:** Dhruv Gupta

---

## 1. Purpose & Scope

This platform replaces a manual workflow (a shared CSV/Google Sheet + manually edited Google Docs) for:

- Tracking freelance resources, the projects/batches they've worked on, and their computed payout
- Generating a per-row invoice document automatically from a template
- Letting resources review, approve, or decline their own invoices
- Managing resource onboarding, including KYC-style document collection (Aadhaar, PAN, photo, bank proof, signed NDA)
- Giving admins a single place to sync data, trigger payouts, and track approval/verification status across all resources

**Out of scope for v1:** automated Aadhaar/PAN verification against government databases (requires a licensed third-party KYC vendor — treated as a phase 2 decision), self-signup (accounts are seeded from the sheet, not created by users), payment execution itself (the platform generates the invoice; actual bank transfer remains a separate, manual step by Biz-Tech's finance process).

---

## 2. System Context

Two human actors, three external systems:

```
                    ┌─────────────┐
                    │   Admin     │
                    └──────┬──────┘
                           │
                           ▼
   ┌───────────────────────────────────────────┐
   │        Resource Payout & Invoice           │
   │              Platform                      │◄──── Resource
   └───────────────────────────────────────────┘
        │              │               │
        ▼              ▼               ▼
   Google Cloud     Resend         (Future: KYC
   (Sheets/Docs/    (email)         verification
    Drive APIs)                     vendor)
```

- **Admin** — internal ops role. Syncs data, generates invoices, reviews documents, manages resource records.
- **Resource** — the freelancer/candidate. Onboards once, keeps details locked, reviews and approves/declines invoices, uploads KYC documents.
- **Google Cloud (service account)** — source of truth for resource/payout data (Sheets) and the mechanism for producing invoice documents (Docs, Drive).
- **Resend** — outbound transactional email for the six notification events (see §7).

---

## 3. Architecture / Component View

```
┌─────────────────────────┐
│  Frontend (React/Vite,   │
│  built via Lovable)      │
│  - Admin routes           │
│  - Resource routes        │
└────────────┬─────────────┘
             │ REST + session cookie
             ▼
┌─────────────────────────────────────────┐
│           Express API server              │
│  - Auth (session, role-scoped middleware) │
│  - Sync orchestration                     │
│  - Invoice generation orchestration       │
│  - Document review                        │
│  - Duplicate/flag detection               │
│  - Notification triggers                  │
└───────┬──────────────┬──────────┬─────────┘
        │              │          │
        ▼              ▼          ▼
 ┌────────────┐  ┌───────────┐  ┌────────────────┐
 │ PostgreSQL │  │  Redis     │  │  Google Cloud    │
 │ (system of │  │  (BullMQ   │  │  (service acct)  │
 │  record)   │  │   queue)   │  │  Sheets/Docs/    │
 └────────────┘  └─────┬─────┘  │  Drive APIs      │
                        │        └────────────────┘
                        ▼
                 ┌──────────────┐
                 │ BullMQ worker │
                 │ (invoice job  │
                 │  processing)  │
                 └──────────────┘

                 ┌──────────────┐
                 │   Resend      │  (called directly from
                 │  (email)      │   the API on state changes)
                 └──────────────┘
```

**Key architectural decisions and why:**

| Decision | Reasoning |
|---|---|
| Standalone Express API, not Next.js monolith | Frontend is built separately in Lovable (Vite/React), and a persistent BullMQ worker doesn't fit a serverless model — Express as an always-on process supports both cleanly. |
| PostgreSQL as system of record | Relational data with clear ownership (Resource → Invoice → SheetRow) fits relational modeling well; no need for NoSQL flexibility here. |
| Google Sheets as source of truth, full-replace sync | Admin explicitly manages data in the Sheet, not the platform; "latest sheet wins" avoids building conflict-resolution logic that isn't needed. |
| One invoice per sheet row, never aggregated | Confirmed requirement — a resource on multiple projects gets multiple separate invoices/documents, actioned independently. |
| Google Drive for document storage (not S3) | Already deep in the Google ecosystem via the service account; one fewer vendor/credential to secure and audit. |
| BullMQ + Redis for invoice generation | Chosen over pure synchronous processing because of connection-timeout risk on longer batches, and over "background processing without a queue" for crash recovery and controlled rate-limiting against Google's API quotas. |
| Duplicate/stale-amount detection is hard-blocking | Given this handles real payouts, flagged rows require explicit per-row admin acknowledgment rather than silent pass-through or bulk override. |

---

## 4. Non-Functional Requirements

Stated explicitly because they justify several of the decisions above — this is not a high-throughput consumer system, and shouldn't be engineered like one.

- **Scale:** low hundreds of resources; invoice batches of tens to a few hundred rows, triggered manually a few times a week — not continuous throughput.
- **Concurrency:** a handful of admin users at most; resource traffic is bursty (spikes after invoice generation, otherwise idle).
- **Availability:** brief downtime during idle periods is acceptable; downtime *during* an in-flight invoice generation batch is not — hence the queue's crash-recovery design (§6).
- **Data integrity over speed:** every workflow (sync, generation, unlock, duplicate detection) favors correctness and auditability over minimizing latency.
- **Security posture:** handles bank account details, PAN, and Aadhaar — treated as sensitive by default (see §9), not as an afterthought.
- **Cost target:** near-zero at current scale; acceptable to introduce modest paid tiers only if usage genuinely grows (see §10).

---

## 5. Core Workflows

### 5.1 Sync (Admin)
1. Admin triggers sync from the dashboard.
2. API reads the linked Google Sheet via the Sheets API.
3. Every existing `SheetRow` is replaced (full snapshot — sheet is always authoritative).
4. Each row is matched to a `Resource` by email (creating one if it doesn't exist yet).
5. Summary returned to admin (rows synced, new resources created).

### 5.2 Invoice Generation (Admin)
1. Admin selects a start/end row range (or specific rows via checkbox).
2. API runs duplicate/stale-amount detection across the selected rows (§8) — flagged rows are held out.
3. For clean rows: `Invoice` records created (`queued`), one BullMQ job enqueued per invoice (`{ invoiceId }` only).
4. Worker, per job: fetch data → copy template (Drive) → fill placeholders (Docs `batchUpdate`) → move/share (Drive) → mark `generated` → trigger the "payout generated" notification email. The document is generated in full at this point, regardless of anything the resource has done yet — see §5.6, gate 1 is about *visibility*, not generation timing.
5. Failures after retries are exhausted are marked `failed` and remain visible with a manual retry option.
6. Flagged rows require explicit per-row admin acknowledgment before their jobs are enqueued.

### 5.3 Onboarding (Resource, first login only)
1. Resource logs in for the first time (`onboarding_completed = false`) → routed to `/onboarding`.
2. Submits contact details, bank details, and uploads all 5 required documents.
3. On submit: `bank_locked = true`, `onboarding_completed = true`, `Document` rows created (`pending_review`).
4. All subsequent logins land on `/invoices` normally.

### 5.4 Document Review (Admin)
1. Admin reviews each pending document on a resource's detail page.
2. Verify or Reject (+ reason) → status updated, reviewer + timestamp logged.
3. Rejected documents notify the resource by email; resource can re-upload, which resets status to `pending_review` and notifies the admin.

### 5.5 Bank Detail Unlock (Admin-initiated, Resource-completed)
1. Admin clicks "Unlock" on a resource → logged in `BankUnlockLog`, resource notified by email.
2. Resource's `/profile` becomes editable until they save.
3. On save: fields updated, `bank_locked = true` again, unlock log entry closed (`edited_at`, `re_locked_at`).
4. Admin never edits these fields directly — preserves the anti-fraud control that motivated locking them in the first place.

### 5.6 Payout confirmation & Approve/Decline (Resource) — two sequential gates

Corrected after initial build (see LLD §0.9 for the full technical rationale): the resource doesn't review the invoice document directly. They first confirm the *amount*; only after that do they ever see the document.

**Gate 1 — confirm the payout amount:**
1. Once generation finishes, the resource is emailed that their **payout** is ready — not that an invoice exists. No document link is included; the document already exists in the background (§5.2 step 4), it's just not shown yet.
2. Resource confirms or rejects the amount (ownership verified server-side from the session, not trusted from the URL, same as always).
3. Reject (+ optional reason): admin notified by email. The row is held — it was generated against data that turned out to be wrong, so nothing regenerates automatically. An admin corrects the underlying sheet data and explicitly reprocesses the row, which re-derives the amount and re-runs generation against the same invoice identity (same invoice number; the existing Drive file gets refilled with corrected content rather than a new one being created).
4. Confirm: the invoice document becomes visible to the resource, gate 2 becomes actionable.

**Gate 2 — review the actual invoice (unchanged from the original design, now gated behind gate 1):**
5. Resource acts on the now-visible invoice.
6. Approve: status updated.
7. Decline (+ optional reason): status updated, admin notified by email.

### 5.7 Payout Reconciliation — deferred, not yet specified

After gate 2 approval, Biz-Tech's finance process pays the resource outside the platform (§1, out of scope: "payment execution itself... remains a separate, manual step"). The intent is for someone to later cross-check a payouts-done file against invoices the platform generated and approved, and flag ones invoiced but not paid. Not specified yet — see LLD §0.10 for exactly what's undecided (file format, matching key, eligible states, recipients). Tracked, targeted for a later build phase.

---

## 6. Job Queue Design

- **Queue:** BullMQ, backed by Redis.
- **Job payload:** `{ invoiceId }` only — all other data is fetched fresh from Postgres at execution time.
- **Idempotent resume:** `drive_file_id` is persisted immediately after the template copy step, before the fill/share steps run. On retry, if a `drive_file_id` already exists, the copy step is skipped and the job resumes from filling — preventing duplicate orphaned Drive files.
- **Retries:** small fixed attempt count (e.g. 3) with exponential backoff; exhausted retries mark the invoice `failed` with the error stored, visible on the dashboard with a manual retry action.
- **Rate limiting:** worker concurrency and a global rate limiter configured to stay under Google API quota (Docs/Drive), preventing quota-driven failure waves on large batches.

---

## 7. Notifications

| Event | Recipient | Trigger point |
|---|---|---|
| Payout generated *(renamed from "Invoice generated" — §5.6)* | Resource | End of successful generation job — no document link yet |
| Amount rejected *(new — §5.6, gate 1)* | Admin | Resource rejects the payout amount |
| Document verified | Resource | Admin marks a document verified |
| Document rejected | Resource | Admin marks a document rejected (includes reason) |
| Bank details unlocked | Resource | Admin clicks Unlock |
| Invoice declined | Admin | Resource declines an invoice (gate 2) |
| Document re-uploaded after rejection | Admin | Resource re-uploads a previously rejected document |

All sends are logged in `NotificationLog` (event type, recipient, related record, timestamp, status) so delivery can be verified if a resource reports not receiving an email.

---

## 8. Duplicate & Stale-Amount Detection

Runs at generation time, before any `Invoice` row is created for the selected range:

- **Same resource + same project + same batch** already has a generated, non-declined invoice → flagged.
- **Same resource + same amount** within the last **90 days** → flagged.

Both flags are **hard-blocking**: the row is held out of the batch until the admin explicitly acknowledges it, per row. Every acknowledgment is logged (`flag_reason`, `flag_acknowledged_by`, `flag_acknowledged_at`) for audit purposes.

---

## 9. Security & Compliance Notes

- **Service account scope:** limited to the one linked Sheet and one Drive folder — not broad Drive/Sheets access.
- **Ownership checks on every resource-facing action:** resource identity is always derived from the session, never from a client-supplied ID; action endpoints (e.g. approve/decline) additionally verify the record belongs to the requesting resource before acting.
- **Sensitive document handling:** Aadhaar/PAN/bank proof stored in a restricted Drive folder structure, access limited to admin roles, with reviewer + timestamp logged on every verification action. UIDAI guidance on masking Aadhaar numbers where displayed should be followed in the UI.
- **Bank detail changes:** never editable by the resource except during a deliberately admin-initiated unlock window; never editable directly by the admin — preserves a clear audit trail on the single highest-fraud-risk data in the system.
- **Open item, not yet resolved:** legal/compliance sign-off on collecting and retaining Aadhaar/PAN copies under the DPDP Act, 2023 — should be resolved before onboarding goes live with real documents, not treated as a technical afterthought.

---

## 10. Deployment View & Cost Estimate

| Component | Suggested provider | Free tier fit | If scale grows |
|---|---|---|---|
| Frontend (static SPA) | Vercel or Netlify | Free | ~$20/mo (Pro), only for team features |
| Express API | Render or Railway | Free (with cold-start on idle) | ~$7–20/mo for always-on |
| PostgreSQL | Neon or Supabase | Free (0.5GB) | ~$19–25/mo |
| Redis (BullMQ) | Upstash | Free (10k commands/day) | ~$10/mo at higher volume |
| Document/invoice storage | Google Drive (existing service account) | Free (within Google Workspace/Drive quota) | N/A — no separate cost |
| Email | Resend | Free (3,000/month) | ~$20/mo far beyond current volume |
| Domain (optional) | — | — | ~$10–15/year |

**Estimated cost at current scale: $0–20/month.** A realistic growth scenario (1,000+ resources, weekly batches, several concurrent admins) would likely land around **$30–60/month total** — this remains an I/O-bound internal tool, not a compute- or storage-heavy system.

---

## 11. Open Items Before Implementation

These are not architectural gaps — the design above is complete — but they are decisions or setup steps that haven't happened yet:

1. **Credential/invite flow** — how a resource or admin gets their first login credentials is not yet defined (sync currently only creates a `Resource` record, not an account they can log into).
2. **Password reset flow** — deferred during UI design, needs a minimal real implementation.
3. **Legal/compliance sign-off** on Aadhaar/PAN/document retention (§9).
4. **Google Cloud service account** has not yet been created — required before Sync or Invoice Generation can be implemented against anything real.
5. **Low-Level Design (LLD)** — Prisma schema, full API request/response contracts, and the exact Docs API `batchUpdate` payload shape are the next deliverable, to be written just before implementation begins.
6. **Payout reconciliation** (§5.7) — comparing a payouts-done file against generated+approved invoices and flagging mismatches to admins. Confirmed as wanted, not yet specified — see LLD §0.10.

---

## 12. Data Model Summary

| Entity | Purpose | Key relationships |
|---|---|---|
| `Resource` | One row per person | 1—N `SheetRow`, `Invoice`, `Document`, `BankUnlockLog` |
| `AdminUser` | Separate table from `Resource` | 1—N `BankUnlockLog`, `Document` (as reviewer) |
| `SheetRow` | One row per synced sheet entry, replaced on each sync | 1—1 `Invoice` |
| `Invoice` | One per generated invoice, never aggregated across rows | Belongs to `SheetRow` + `Resource` |
| `Document` | One per KYC document type per resource | Belongs to `Resource`; reviewed by `AdminUser` |
| `BankUnlockLog` | Audit trail for the unlock/re-lock flow | Belongs to `Resource`; initiated by `AdminUser` |
| `NotificationLog` | One row per email sent | References the triggering record |

Full field-level detail is deferred to the LLD (§11.5).

---

*This document reflects the architecture as designed through iterative discussion, prior to implementation. It should be updated if decisions change during build.*

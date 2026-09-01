# Deployment runbook (free-tier stack)

| Piece | Provider | Notes |
|---|---|---|
| Frontend | **Vercel** (Hobby) | Always-on. Serves the SSR app; rewrites `/api/*` to the backend. |
| Backend + worker | **Render** free Web Service | Express API + BullMQ worker in one process. Sleeps after ~15 min idle; first hit after sleep cold-starts in ~30–60s. |
| Postgres | **Neon** free | 0.5 GB. |
| Redis | **Upstash** free | 256 MB. Used for the BullMQ queue *and* the session store. |

Same-origin is preserved: the browser only ever talks to the Vercel domain over HTTPS; Vercel proxies `/api/*` to Render server-side, so the `express-session` cookie round-trips with no CORS config.

---

## 0. One-time prep (already done in the repo)

- `src/app.ts` — in production: `trust proxy`, Redis-backed sessions, `Secure` cookie, boots only with a real `SESSION_SECRET` + `REDIS_URL`.
- `GET /api/health` — liveness probe.
- `package.json` — `npm start` runs `dist/src/index.js`; `npm run build` runs `prisma generate && tsc`; `engines.node >= 20`.
- `frontend/vite.config.ts` — nitro `preset: "vercel"`.
- `frontend/vercel.json` — the `/api/*` rewrite (**edit the destination host after step 3**).
- `render.yaml` — Blueprint for the backend service.

Commit and push all of this to the branch you'll deploy from before starting.

---

## 1. Neon — Postgres

1. neon.tech → sign up → **New Project** (region close to Render's, e.g. AWS `us-east`).
2. Copy the **pooled** connection string (Dashboard → Connection Details → "Pooled connection"). It looks like
   `postgresql://user:pass@ep-xxx-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require`.
3. Keep it for step 3. Don't run migrations yet — Render does that on deploy.

## 2. Upstash — Redis

1. upstash.com → sign up → **Create Database** → Redis → region near Render → free tier.
2. On the database page, copy the **`rediss://` URL** (the TLS one, "Node/ioredis" tab). Not the `redis://` one.
3. Keep it for step 3.

## 3. Render — backend

1. github: push this repo (Render needs it on GitHub/GitLab).
2. render.com → sign up → **New → Blueprint** → connect the repo → it reads `render.yaml`.
3. Render will ask for every `sync: false` env var. Fill them from your local `.env` **plus**:
   | Var | Value |
   |---|---|
   | `DATABASE_URL` | Neon pooled string (step 1) |
   | `REDIS_URL` | Upstash `rediss://` URL (step 2) |
   | `SESSION_SECRET` | run `openssl rand -hex 32` locally, paste the output |
   | `FRONTEND_BASE_URL` | leave blank for now; fill in step 4 |
   | `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` | paste the whole value including the literal `\n` sequences — the code converts them |
   | everything else `GOOGLE_*`, `RESEND_*`, `ADMIN_NOTIFICATION_EMAIL` | copy from local `.env` |
4. **Apply** → Render builds, then the start command runs `prisma migrate deploy` (idempotent) and boots the service.
5. When it's live, note the URL: `https://payout-invoice-api.onrender.com`.
6. Sanity check: open `https://payout-invoice-api.onrender.com/api/health` → `{"status":"ok"}`.

### Seed the admin login

Render Dashboard → the service → **Shell** tab:

```bash
ADMIN_EMAIL="you@example.com" ADMIN_PASSWORD="a-strong-password" node scripts/seed-admin.js
```

(Re-run any time to reset the password.)

## 4. Vercel — frontend

1. In the repo, edit `frontend/vercel.json` → replace `REPLACE_WITH_BACKEND_HOST` with the Render host
   (`payout-invoice-api.onrender.com`, no scheme in the placeholder spot — the line becomes
   `"destination": "https://payout-invoice-api.onrender.com/api/:path*"`). Commit + push.
2. vercel.com → sign up → **Add New → Project** → import the repo.
3. **Root Directory** → set to `frontend`.
4. Framework preset: "Vite" (or "Other" — the build already emits `.vercel/output`, Vercel picks it up).
   - **Install command: `npm install`** — override the default. The repo ships `bun.lock` + `bunfig.toml`; left alone Vercel would use bun, and `bunfig.toml`'s 24h release-age guard can stall the install.
   - Build command: `npm run build` (default)
   - Output: leave default (Vercel detects the Build Output API dir).
5. Env vars: none required for the frontend.
6. **Deploy**. Note the URL: `https://<project>.vercel.app`.
7. Go back to **Render → env** → set `FRONTEND_BASE_URL = https://<project>.vercel.app` → save (triggers a redeploy). This is the URL used in invite emails.

## 5. Smoke test

Open `https://<project>.vercel.app`:

1. `/login` → sign in with the seeded admin. (First load may be slow while Render wakes.)
2. Dashboard → **Sync from Google Sheets** → rows appear.
3. **Resources** → invite a resource → check the email → the link must point at the **Vercel** URL.
4. Accept the invite in a different browser → onboard → upload a document.
5. Back as admin → verify the document, generate an invoice, watch it reach GENERATED.
6. **Redeploy the Render service** (Manual Deploy → Deploy latest) → reload the frontend → you should still be logged in. This proves `trust proxy` + `Secure` cookie + Redis session store are all correct. If you're logged out, see Troubleshooting.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Login "succeeds" but next request is 403, and you're bounced to `/login` | The `Secure` cookie isn't being set. Confirm `NODE_ENV=production` on Render and that Vercel is proxying (not redirecting) `/api`. Check `frontend/vercel.json` destination is `https://` and correct. |
| `/api/*` returns Vercel 404 | `vercel.json` not picked up — ensure Root Directory is `frontend` and the file is at `frontend/vercel.json`. |
| Backend boot crash: "SESSION_SECRET must be set…" / "REDIS_URL must be set…" | Those env vars are missing on Render. |
| Backend logs: `ECONNREFUSED` / Redis auth errors | Using `redis://` instead of Upstash's `rediss://` (TLS). |
| Invoice generation stuck at QUEUED | The Render service went to sleep. Hit any page to wake it; the worker drains the queue on wake (jobs persist in Redis, nothing lost). |
| First request each morning takes ~1 min | Render free cold start. Expected. Upgrade the service to a paid instance to keep it warm, or add an external uptime pinger. |
| Cold starts too painful | Move the backend to Render Starter ($7/mo) — nothing else changes. |

## When you add a custom domain later

1. Add it to the Vercel project.
2. Update `FRONTEND_BASE_URL` on Render to the new domain.
3. `frontend/vercel.json` destination stays the Render host — no change.

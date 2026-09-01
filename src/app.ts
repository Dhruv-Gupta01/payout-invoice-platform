import express, { ErrorRequestHandler } from "express";
import session from "express-session";
import RedisStore from "connect-redis";
import IORedis from "ioredis";
import { Prisma } from "@prisma/client";
import "./auth/types";
import { authRouter } from "./auth/routes";
import { requireRole } from "./auth/middleware";
import { createAdminRouter } from "./admin/router";
import { createResourceRouter } from "./resource/router";
import { AppDependencies } from "./dependencies";

// Routes (sync, invoices, etc.) are added in later phases, each preceded by
// a failing test per the LLD §2 API contracts.

// Not LLD-specified; a real robustness bug found live (Phase 9 manual
// browser check): a stale/unknown id hit `findUniqueOrThrow` unguarded in a
// route handler — Express 4 doesn't auto-catch a rejected promise from an
// async handler, so the request never got a response (infinite spinner
// client-side) and the uncaught rejection crashed the *entire* process,
// taking the API down for every other in-flight request too. Every route
// across all routers is now wrapped in asyncHandler (src/lib/asyncHandler.ts)
// so a rejection reaches this instead of the process's global handler.
const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
    return res.status(404).json({ error: "Not found" });
  }
  // eslint-disable-next-line no-console
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
};

const IS_PRODUCTION = process.env.NODE_ENV === "production";

// In production the app sits behind two proxies (the platform's edge and the
// frontend's /api rewrite), both terminating TLS. `trust proxy` makes
// express-session read `X-Forwarded-Proto` so a `secure` cookie is set on
// the HTTPS the browser actually used, and the session store must be shared
// (Redis) since the API dyno can restart or run multiple instances — the
// default in-memory store would drop every session on each redeploy.
function buildSessionMiddleware() {
  const secret = process.env.SESSION_SECRET || "dev-only-secret-change-me";
  if (IS_PRODUCTION && secret === "dev-only-secret-change-me") {
    throw new Error("SESSION_SECRET must be set to a real value in production.");
  }

  const options: session.SessionOptions = {
    secret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: IS_PRODUCTION,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  };

  if (IS_PRODUCTION) {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
      throw new Error("REDIS_URL must be set in production (used for the session store).");
    }
    const client = new IORedis(redisUrl);
    options.store = new RedisStore({ client, prefix: "sess:" });
  }

  return session(options);
}

export function createApp(deps: AppDependencies) {
  const app = express();
  if (IS_PRODUCTION) {
    // Requests reach the API through more than one proxy in production (the
    // frontend's /api rewrite -> the platform edge -> this process). Trust
    // the whole chain so express-session sees `X-Forwarded-Proto: https` and
    // actually sets the `secure` session cookie. We don't use the client IP
    // for anything security-sensitive, so trusting all hops is fine here.
    app.set("trust proxy", true);
  }
  app.use(express.json());
  app.use(buildSessionMiddleware());

  // Liveness probe for the hosting platform — no auth, no session.
  app.get("/api/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.use("/api/auth", authRouter);
  app.use("/api/admin", requireRole("admin"), createAdminRouter(deps));
  app.use("/api/resource", requireRole("resource"), createResourceRouter(deps));
  app.use(errorHandler);
  return app;
}

import express, { ErrorRequestHandler } from "express";
import session from "express-session";
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

export function createApp(deps: AppDependencies) {
  const app = express();
  app.use(express.json());
  app.use(
    session({
      secret: process.env.SESSION_SECRET || "dev-only-secret-change-me",
      resave: false,
      saveUninitialized: false,
    })
  );
  app.use("/api/auth", authRouter);
  app.use("/api/admin", requireRole("admin"), createAdminRouter(deps));
  app.use("/api/resource", requireRole("resource"), createResourceRouter(deps));
  app.use(errorHandler);
  return app;
}

import { RequestHandler } from "express";

// Express 4 does not catch a rejected promise thrown from an async route
// handler — left unguarded, that becomes an unhandled Node rejection, which
// (found live, Phase 9 manual browser check) crashes the entire process,
// not just the one request. Wrapping every route in this forwards any
// rejection to Express's error-handling middleware (see app.ts) instead.
export function asyncHandler(fn: RequestHandler): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

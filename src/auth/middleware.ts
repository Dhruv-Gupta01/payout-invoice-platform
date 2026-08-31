import { RequestHandler } from "express";

// LLD §2 (preamble): "All /admin/* and /resource/* routes require a valid
// session; middleware checks the session's role against the route namespace
// and rejects (403) on mismatch." A missing session (role undefined) is
// treated as a mismatch too — same rejection path, no session to match.
export function requireRole(role: "admin" | "resource"): RequestHandler {
  return (req, res, next) => {
    if (req.session.role !== role) {
      return res.status(403).json({ error: "Forbidden" });
    }
    next();
  };
}

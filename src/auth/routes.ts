import { Router } from "express";
import { prisma } from "../lib/prisma";
import { comparePassword, hashPassword } from "./password";
import { asyncHandler } from "../lib/asyncHandler";

export const authRouter = Router();

// LLD §2.1
// POST /auth/login
// Request:  { email: string, password: string }
// Response 200: { id, email, name, role: "admin" | "resource" }  (+ sets session cookie)
// Response 401: { error: "Invalid credentials" }
//
// AdminUser is checked first, then Resource. The LLD doesn't specify what
// happens if the same email exists in both tables (each is only unique
// within its own table) — flagged to the user; AdminUser-first is the
// working assumption until that's settled.
authRouter.post("/login", asyncHandler(async (req, res) => {
  const { email, password } = req.body ?? {};

  if (typeof email !== "string" || typeof password !== "string") {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const admin = await prisma.adminUser.findUnique({ where: { email } });
  if (admin && (await comparePassword(password, admin.passwordHash))) {
    req.session.userId = admin.id;
    req.session.role = "admin";
    return res.status(200).json({
      id: admin.id,
      email: admin.email,
      name: admin.name,
      role: "admin",
    });
  }

  const resource = await prisma.resource.findUnique({ where: { email } });
  if (resource && resource.passwordHash && (await comparePassword(password, resource.passwordHash))) {
    req.session.userId = resource.id;
    req.session.role = "resource";
    return res.status(200).json({
      id: resource.id,
      email: resource.email,
      name: resource.name,
      role: "resource",
    });
  }

  return res.status(401).json({ error: "Invalid credentials" });
}));

// LLD §2.1
// GET /auth/me
// Response 200: { id, email, name, role }
// Response 401: { error: "Not authenticated" }
//
// Looks up whichever table matches the session's role — mirrors the two
// branches in POST /auth/login above. A resource session must round-trip
// here too (needed for the frontend's resource-side pages to survive a
// page refresh).
authRouter.get("/me", asyncHandler(async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  if (req.session.role === "admin") {
    const admin = await prisma.adminUser.findUnique({ where: { id: req.session.userId } });
    if (!admin) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    return res.status(200).json({
      id: admin.id,
      email: admin.email,
      name: admin.name,
      role: "admin",
    });
  }

  if (req.session.role === "resource") {
    const resource = await prisma.resource.findUnique({ where: { id: req.session.userId } });
    if (!resource) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    return res.status(200).json({
      id: resource.id,
      email: resource.email,
      name: resource.name,
      role: "resource",
    });
  }

  return res.status(401).json({ error: "Not authenticated" });
}));

// LLD §2.1
// POST /auth/logout
// Response 204
//
// Specified from the start but never built — no route, no frontend button.
// Idempotent: destroying a session that doesn't exist still succeeds.
authRouter.post("/logout", asyncHandler(async (req, res) => {
  await new Promise<void>((resolve, reject) => {
    req.session.destroy((err) => (err ? reject(err) : resolve()));
  });
  res.clearCookie("connect.sid");
  res.status(204).end();
}));

// LLD §0.25
// POST /auth/accept-invite
// Request: { token: string, password: string }
// Response 200: { id, email, name, role: "resource" }  (+ session cookie — same as login,
//   logged in immediately, no separate login step)
// Response 400: { error: "Invalid or expired invite link" }
authRouter.post("/accept-invite", asyncHandler(async (req, res) => {
  const { token, password } = req.body ?? {};

  if (typeof token !== "string" || typeof password !== "string") {
    return res.status(400).json({ error: "Invalid or expired invite link" });
  }

  const resource = await prisma.resource.findUnique({ where: { inviteToken: token } });
  if (!resource || !resource.inviteTokenExpiresAt || resource.inviteTokenExpiresAt < new Date()) {
    return res.status(400).json({ error: "Invalid or expired invite link" });
  }

  const passwordHash = await hashPassword(password);
  const updated = await prisma.resource.update({
    where: { id: resource.id },
    data: { passwordHash, inviteToken: null, inviteTokenExpiresAt: null },
  });

  req.session.userId = updated.id;
  req.session.role = "resource";
  return res.status(200).json({
    id: updated.id,
    email: updated.email,
    name: updated.name,
    role: "resource",
  });
}));

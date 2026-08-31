import bcrypt from "bcryptjs";

export function comparePassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

// Used by POST /auth/accept-invite (LLD §0.25) — the one place a resource
// sets their own password, rather than one being manually seeded.
export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

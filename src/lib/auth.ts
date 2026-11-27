import "server-only";
import bcrypt from "bcryptjs";
import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { systemQuery, type Actor } from "./db";

export const SESSION_COOKIE = "fga_session";

export interface Session extends Actor {
  email: string;
  name: string;
  teamMemberId: string | null;
}

function secret() {
  // A built-in fallback keeps the zero-config demo working. Set SESSION_SECRET for any real use.
  const s = process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "fga-demo-fallback-secret-ZqVt2xK9mR4wLp7nB3cH8sJd";
  return new TextEncoder().encode(s);
}

export async function verifyPassword(email: string, password: string): Promise<string | null> {
  const rows = await systemQuery<{ id: string; password_hash: string }>("select id, password_hash from app_users where lower(email) = lower($1)", [email.trim()]);
  if (!rows[0]) {
    await bcrypt.compare(password, "$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinv"); // even out timing
    return null;
  }
  return (await bcrypt.compare(password, rows[0].password_hash)) ? rows[0].id : null;
}

export async function startSession(userId: string) {
  const token = await new SignJWT({ uid: userId }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("7d").sign(secret());
  (await cookies()).set(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 60 * 60 * 24 * 7 });
}

export async function endSession() {
  (await cookies()).delete(SESSION_COOKIE);
}

// The signed cookie proves who the user is; their row (name, role) is kept in memory for 30 s so most
// requests skip that lookup. Role changes therefore apply within 30 seconds.
const USER_TTL_MS = 30_000;
type UserRow = { id: string; workspace_id: string; role: Session["role"]; email: string; display_name: string; team_member_id: string | null };
declare global {
  var __fgaUsers: Map<string, { at: number; row: UserRow | null }> | undefined;
}
async function loadUser(uid: string): Promise<UserRow | null> {
  const m = (globalThis.__fgaUsers ??= new Map());
  const hit = m.get(uid);
  if (hit && Date.now() - hit.at < USER_TTL_MS) return hit.row;
  const rows = await systemQuery<UserRow>("select id, workspace_id, role, email, display_name, team_member_id from app_users where id = $1", [uid]);
  m.set(uid, { at: Date.now(), row: rows[0] ?? null });
  return rows[0] ?? null;
}

// cache() shares one lookup between the layout and the page within a single request.
export const getSession = cache(async (): Promise<Session | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret());
    const u = await loadUser(String(payload.uid));
    if (!u) return null;
    return { userId: u.id, workspaceId: u.workspace_id, role: u.role, email: u.email, name: u.display_name, teamMemberId: u.team_member_id };
  } catch {
    return null;
  }
});

export async function requireSession(): Promise<Session> {
  const s = await getSession();
  if (!s) redirect("/login");
  return s;
}

export const ROLE_LABEL: Record<Session["role"], string> = {
  admin: "Admin",
  campaign_manager: "Campaign Manager",
  team_member: "Team Member",
};

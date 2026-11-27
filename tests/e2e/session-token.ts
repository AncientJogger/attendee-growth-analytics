// Prints a session cookie value for a demo user (local smoke tests only).
import { SignJWT } from "jose";
import { withSystem, closePool } from "../../src/lib/db";
const email = process.argv[2] ?? "admin@demo.fest";
withSystem((q) => q<{ id: string }>("select id from app_users where email = $1", [email])).then(async ([u]) => {
  const t = await new SignJWT({ uid: u.id }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("1h").sign(new TextEncoder().encode(process.env.SESSION_SECRET!));
  console.log(t);
  await closePool();
});

import { withSystem, withUser, type Actor } from "@/lib/db";
import { getDatasetContext } from "@/lib/analytics/context";

export const WS = "00000000-0000-4000-8000-000000000001";

export async function actor(email: string): Promise<Actor> {
  const [u] = await withSystem((q) => q<{ id: string; role: Actor["role"] }>("select id, role from app_users where email = $1", [email]));
  return { userId: u.id, workspaceId: WS, role: u.role };
}

export async function ctxFor(email = "admin@demo.fest", asOfDate?: string) {
  const a = await actor(email);
  return withUser(a, (q) => getDatasetContext(q, WS, { asOfDate }));
}

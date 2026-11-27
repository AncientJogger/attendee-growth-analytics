import "server-only";
import { cache } from "react";
import { requireSession } from "./auth";
import { systemQuery } from "./db";
import { todayIn } from "./analytics/context";

/*
 * Page cache. Every change in the app (tasks, campaigns, budgets, approvals, imports, corrections,
 * strategy) bumps workspaces.data_version in the same transaction. Cache keys include that number,
 * so a changed workspace can never be served old figures: the next request simply misses and
 * recomputes. A cache hit costs one tiny query (the version check) instead of dozens.
 *
 * The cache lives in the server instance's memory. Each Vercel instance warms its own copy.
 */

const MAX_ENTRIES = 300;
declare global {
  var __fgaPageCache: Map<string, Promise<unknown>> | undefined;
}
const store = () => (globalThis.__fgaPageCache ??= new Map());

/** Version of the workspace's data, read once per request. */
export const workspaceVersion = cache(async (workspaceId: string) => {
  const [w] = await systemQuery<{ v: string; dv: string | null }>(
    "select data_version::text v, active_dataset_version_id::text dv from workspaces where id = $1", [workspaceId]);
  return `${w?.v ?? 0}:${w?.dv ?? ""}`;
});

/**
 * Returns the cached result for (key parts, user, data version, today's date), computing it once on a miss.
 * The user id is part of the key because row-level security can show different rows to different people.
 */
export async function cachedPage<T>(parts: unknown[], compute: () => Promise<T>): Promise<T> {
  if (process.env.PAGE_CACHE === "off") return compute();
  const s = await requireSession();
  const key = JSON.stringify([parts, s.userId, await workspaceVersion(s.workspaceId), todayIn(330)]);
  const m = store();
  const hit = m.get(key);
  if (hit) {
    m.delete(key);
    m.set(key, hit); // most recently used goes to the end
    return hit as Promise<T>;
  }
  const p = compute();
  m.set(key, p);
  p.catch(() => m.delete(key));
  while (m.size > MAX_ENTRIES) m.delete(m.keys().next().value!);
  return p;
}

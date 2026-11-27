import "server-only";
import { requireSession, type Session } from "./auth";
import { withUser, type Q } from "./db";
import { getDatasetContext, type DatasetContext } from "./analytics/context";

/** Loads the session and active dataset context for a page, then runs fn in one RLS-scoped transaction. */
export async function pageData<T>(asof: string | string[] | undefined, fn: (q: Q, ctx: DatasetContext | null, s: Session) => Promise<T>) {
  const s = await requireSession();
  const asOfDate = typeof asof === "string" ? asof : null;
  return withUser(s, async (q) => {
    const ctx = await getDatasetContext(q, s.workspaceId, { asOfDate });
    const data = await fn(q, ctx, s);
    return { s, ctx, data };
  });
}

/**
 * Like pageData, but the page gets `run`, which executes each call in its own RLS-scoped transaction.
 * Independent queries can then be awaited together with Promise.all, so a page costs the slowest
 * query's round trips instead of the sum of all of them. That matters when the database is far away.
 */
export async function pageDataPar<T>(
  asof: string | string[] | undefined,
  fn: (run: <R>(f: (q: Q) => Promise<R>) => Promise<R>, ctx: DatasetContext | null, s: Session) => Promise<T>,
) {
  const s = await requireSession();
  const asOfDate = typeof asof === "string" ? asof : null;
  const ctx = await withUser(s, (q) => getDatasetContext(q, s.workspaceId, { asOfDate }));
  const data = await fn((f) => withUser(s, (q) => f(q)), ctx, s);
  return { s, ctx, data };
}

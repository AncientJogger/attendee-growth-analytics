import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { systemQuery } from "@/lib/db";

export const dynamic = "force-dynamic";

// Polled by open pages; when the number changes, the page refreshes its server data.
export async function GET() {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  // One round trip; the workspace id comes from the verified session, so no row-level security is needed here.
  const [w] = await systemQuery<{ data_version: string; active_dataset_version_id: string | null }>("select data_version, active_dataset_version_id from workspaces where id = $1", [s.workspaceId]);
  return NextResponse.json({ v: Number(w?.data_version ?? 0), dv: w?.active_dataset_version_id ?? null }, { headers: { "cache-control": "no-store" } });
}

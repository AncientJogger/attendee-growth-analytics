import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth";
import { audit, bumpVersion, withSystem, withUser } from "@/lib/db";
import { parseUpload } from "@/lib/import/parse";
import { importDataset } from "@/lib/import/importer";
import { ENTITY_KEYS } from "@/lib/import/schema";

export const runtime = "nodejs";
export const maxDuration = 300;

const body = z.object({
  uploadId: z.string().uuid(),
  label: z.string().trim().min(2).max(120),
  activate: z.boolean().default(false),
  mapping: z.object({
    timezoneOffsetMinutes: z.number().int().min(-720).max(840).optional(),
    sheets: z.record(z.string(), z.object({ entity: z.enum(["ignore", ...ENTITY_KEYS] as unknown as [string, ...string[]]), columns: z.record(z.string(), z.string()) })),
  }),
});

// Step 2: import into a new dataset version. The original upload is kept; existing versions are never overwritten.
export async function POST(req: Request) {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  if (s.role !== "admin") return NextResponse.json({ error: "Only admins can import datasets." }, { status: 403 });
  const parsed = body.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, { status: 400 });
  const { uploadId, label, activate, mapping } = parsed.data;
  const [up] = await withUser(s, (q) => q<{ filename: string; bytes: Buffer }>("select filename, bytes from dataset_uploads where id = $1", [uploadId]));
  if (!up) return NextResponse.json({ error: "Upload not found. Upload the file again." }, { status: 404 });
  try {
    const sheets = await parseUpload(up.filename, up.bytes);
    // The import itself runs as the table owner (a system job) after the admin check above.
    const result = await withSystem((q, client) => importDataset(q, client, { workspaceId: s.workspaceId, label, filename: up.filename, uploadId, userId: s.userId, sheets, mapping: mapping as never }));
    await withUser(s, async (q) => {
      await audit(q, { workspaceId: s.workspaceId, actorUserId: s.userId, action: "import", entity: "dataset_version", entityId: result.datasetVersionId, after: { label, filename: up.filename, counts: result.counts, warnings: result.warnings } });
      if (activate) {
        await q("update workspaces set active_dataset_version_id = $2 where id = $1", [s.workspaceId, result.datasetVersionId]);
        await audit(q, { workspaceId: s.workspaceId, actorUserId: s.userId, action: "activate_dataset", entity: "dataset_version", entityId: result.datasetVersionId, after: { label } });
      }
      await bumpVersion(q, s.workspaceId);
    });
    return NextResponse.json({ ok: true, ...result, activated: activate });
  } catch (e) {
    const msg = (e as Error).message;
    await withSystem(async (q) => {
      await q("insert into dataset_versions (workspace_id, upload_id, label, source_filename, uploaded_by, status, mapping, notes) values ($1,$2,$3,$4,$5,'failed',$6,$7)",
        [s.workspaceId, uploadId, label, up.filename, s.userId, JSON.stringify(mapping), msg.slice(0, 500)]);
    });
    return NextResponse.json({ error: `Import failed and nothing was changed: ${msg}` }, { status: 400 });
  }
}

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { withUser } from "@/lib/db";
import { MAX_UPLOAD_BYTES, parseUpload, profileSheet, suggestMapping } from "@/lib/import/parse";
import { ENTITIES } from "@/lib/import/schema";
import { sha256 } from "@/lib/import/importer";

export const runtime = "nodejs";
export const maxDuration = 60;

// Step 1 of the wizard: store the original file, profile every sheet and suggest a mapping.
export async function POST(req: Request) {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  if (s.role !== "admin") return NextResponse.json({ error: "Only admins can upload datasets." }, { status: 403 });
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "Attach an .xlsx or .csv file." }, { status: 400 });
  if (file.size > MAX_UPLOAD_BYTES) return NextResponse.json({ error: `File is over ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.` }, { status: 413 });
  const bytes = Buffer.from(await file.arrayBuffer());
  let sheets;
  try {
    sheets = await parseUpload(file.name, bytes);
  } catch (e) {
    return NextResponse.json({ error: `Could not read the file: ${(e as Error).message}` }, { status: 400 });
  }
  if (!sheets.length || sheets.every((x) => x.rows.length === 0)) return NextResponse.json({ error: "The file has no data rows." }, { status: 400 });
  const [up] = await withUser(s, (q) => q<{ id: string }>("insert into dataset_uploads (workspace_id, filename, bytes, sha256, uploaded_by) values ($1,$2,$3,$4,$5) returning id",
    [s.workspaceId, file.name, bytes, sha256(bytes), s.userId]));
  const entities = Object.fromEntries(Object.entries(ENTITIES).map(([k, e]) => [k, { label: e.label, description: e.description, unlocks: e.unlocks, fields: Object.fromEntries(Object.entries(e.fields).map(([fk, f]) => [fk, { label: f.label, type: f.type, required: !!(f as { required?: boolean }).required }])) }]));
  return NextResponse.json({
    uploadId: up.id, filename: file.name,
    sheets: sheets.map((sh) => ({
      name: sh.name, rowCount: sh.rows.length, headers: sh.headers, profile: profileSheet(sh),
      sample: sh.rows.slice(0, 5).map((r) => r.map((v) => (v instanceof Date ? v.toISOString().slice(0, 19).replace("T", " ") : v === null ? "" : String(v).slice(0, 60)))),
    })),
    suggestion: suggestMapping(sheets), entities,
  });
}

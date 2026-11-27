"use client";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

type FieldMeta = { label: string; type: string; required: boolean };
type EntityMeta = { label: string; description: string; unlocks: string; fields: Record<string, FieldMeta> };
type Sheet = { name: string; rowCount: number; headers: string[]; profile: { header: string; inferredType: string; nullRate: number; distinct: number; examples: string[] }[]; sample: string[][] };
type Upload = { uploadId: string; filename: string; sheets: Sheet[]; suggestion: { sheets: Record<string, { entity: string; columns: Record<string, string> }> }; entities: Record<string, EntityMeta> };
type Result = { datasetVersionId: string; counts: Record<string, { sheet: string; read: number; imported: number; duplicatesRemoved: number; rejected: number }>; warnings: string[]; capabilities: Record<string, boolean>; rejectedSample: { sheet: string; row: number; reason: string }[]; rawRowsStored: number; activated: boolean };

const cls = { btn: "rounded-lg border border-line bg-white px-3 py-1.5 text-sm font-medium hover:bg-brand-soft disabled:opacity-50", primary: "rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50", input: "rounded-md border border-line bg-white px-2 py-1 text-sm" };

export function ImportWizard() {
  const router = useRouter();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [up, setUp] = useState<Upload | null>(null);
  const [mapping, setMapping] = useState<Record<string, { entity: string; columns: Record<string, string> }>>({});
  const [label, setLabel] = useState("");
  const [activate, setActivate] = useState(true);
  const [tz, setTz] = useState("330");
  const [result, setResult] = useState<Result | null>(null);

  const upload = async (f: File) => {
    setBusy(true); setErr(null);
    const fd = new FormData(); fd.set("file", f);
    const r = await fetch("/api/datasets/upload", { method: "POST", body: fd });
    const j = await r.json();
    setBusy(false);
    if (!r.ok) return setErr(j.error ?? "Upload failed");
    setUp(j); setMapping(j.suggestion.sheets); setLabel(f.name.replace(/\.(xlsx|csv)$/i, "")); setStep(2);
  };

  const problems = useMemo(() => {
    if (!up) return [];
    const out: string[] = [];
    const used = new Map<string, string>();
    for (const [sheet, m] of Object.entries(mapping)) {
      if (m.entity === "ignore") continue;
      if (used.has(m.entity)) out.push(`${up.entities[m.entity].label} is mapped twice (${used.get(m.entity)} and ${sheet}).`);
      used.set(m.entity, sheet);
      for (const [fk, f] of Object.entries(up.entities[m.entity].fields)) if (f.required && !m.columns[fk]) out.push(`${sheet}: required field "${f.label}" is not mapped.`);
    }
    if (!used.has("check_ins") && !used.has("registrations")) out.push("Map at least a check-ins or a registrations sheet.");
    return out;
  }, [mapping, up]);

  const missingNotes = useMemo(() => {
    if (!up) return [];
    const mapped = new Set(Object.values(mapping).map((m) => m.entity));
    return Object.entries(up.entities).filter(([k]) => !mapped.has(k)).map(([, e]) => `${e.label} not mapped: ${e.unlocks.replace(/\.$/, "")} will be unavailable.`);
  }, [mapping, up]);

  const runImport = async () => {
    if (!up) return;
    setBusy(true); setErr(null);
    const r = await fetch("/api/datasets/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ uploadId: up.uploadId, label, activate, mapping: { timezoneOffsetMinutes: Number(tz), sheets: mapping } }) });
    const j = await r.json();
    setBusy(false);
    if (!r.ok) return setErr(j.error ?? "Import failed");
    setResult(j); setStep(3); router.refresh();
  };

  return (
    <div className="rounded-xl border border-line bg-white p-5">
      <ol className="mb-4 flex gap-4 text-xs font-medium text-muted">
        {["Upload", "Map and validate", "Result"].map((s, i) => <li key={s} className={step === i + 1 ? "text-brand" : ""}>{i + 1}. {s}</li>)}
      </ol>
      {err && <p role="alert" className="mb-3 rounded bg-bad-soft px-3 py-2 text-sm text-bad">{err}</p>}

      {step === 1 && (
        <div>
          <p className="mb-3 text-sm text-ink-2">Upload an .xlsx workbook or a .csv file (up to 15 MB; 4 MB on Vercel). The original file is stored unchanged, and the import creates a new dataset version; the current one is never overwritten. Cell values are read as data only; formulas are not executed.</p>
          <input type="file" accept=".xlsx,.csv" disabled={busy} onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} className="text-sm" aria-label="Choose a dataset file" />
          {busy && <p className="mt-2 text-sm text-muted">Reading and profiling the file…</p>}
        </div>
      )}

      {step === 2 && up && (
        <div className="space-y-4">
          <p className="text-sm text-ink-2"><b>{up.filename}</b>: {up.sheets.length} sheet(s). Mappings were suggested from sheet and column names; check each one. Unmapped columns are kept in the raw copy but not used in metrics.</p>
          {up.sheets.map((sh) => {
            const m = mapping[sh.name] ?? { entity: "ignore", columns: {} };
            const ent = m.entity !== "ignore" ? up.entities[m.entity] : null;
            return (
              <div key={sh.name} className="rounded-lg border border-line p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-semibold">{sh.name} <span className="font-normal text-muted">· {sh.rowCount.toLocaleString("en-IN")} rows · {sh.headers.length} columns</span></span>
                  <label className="text-xs text-muted">Treat as{" "}
                    <select className={cls.input} value={m.entity} onChange={(e) => setMapping({ ...mapping, [sh.name]: { entity: e.target.value, columns: {} } })}>
                      <option value="ignore">Ignore this sheet</option>
                      {Object.entries(up.entities).map(([k, e]) => <option key={k} value={k}>{e.label}</option>)}
                    </select></label>
                </div>
                {ent && <p className="mt-1 text-xs text-muted">{ent.description} Unlocks: {ent.unlocks}</p>}
                {ent && (
                  <div className="mt-2 grid gap-2 md:grid-cols-3">
                    {Object.entries(ent.fields).map(([fk, f]) => (
                      <label key={fk} className="text-xs">
                        <span className={f.required ? "font-medium text-ink" : "text-muted"}>{f.label}{f.required && " *"} <span className="text-muted">({f.type})</span></span>
                        <select className={`${cls.input} mt-0.5 w-full ${f.required && !m.columns[fk] ? "border-bad" : ""}`} value={m.columns[fk] ?? ""}
                          onChange={(e) => { const cols = { ...m.columns }; if (e.target.value) cols[fk] = e.target.value; else delete cols[fk]; setMapping({ ...mapping, [sh.name]: { ...m, columns: cols } }); }}>
                          <option value="">Not mapped</option>
                          {sh.profile.map((p) => <option key={p.header} value={p.header}>{p.header} ({p.inferredType}, {Math.round(p.nullRate * 100)}% empty)</option>)}
                        </select>
                      </label>
                    ))}
                  </div>
                )}
                <details className="mt-2"><summary className="cursor-pointer text-xs text-brand">Preview first rows</summary>
                  <div className="mt-1 overflow-x-auto"><table className="text-[11px]"><thead><tr>{sh.headers.map((h) => <th key={h} className="border border-line bg-[#f4f6fa] px-1 text-left">{h}</th>)}</tr></thead>
                    <tbody>{sh.sample.map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j} className="border border-line px-1">{v}</td>)}</tr>)}</tbody></table></div>
                </details>
              </div>
            );
          })}
          <div className="grid gap-3 md:grid-cols-3">
            <label className="text-xs text-muted">Version label<input className={`${cls.input} mt-0.5 w-full`} value={label} onChange={(e) => setLabel(e.target.value)} /></label>
            <label className="text-xs text-muted">Timezone for times without an offset
              <select className={`${cls.input} mt-0.5 w-full`} value={tz} onChange={(e) => setTz(e.target.value)}><option value="330">IST (+05:30)</option><option value="0">UTC</option></select></label>
            <label className="mt-5 flex items-center gap-2 text-sm"><input type="checkbox" checked={activate} onChange={(e) => setActivate(e.target.checked)} /> Make this the active dataset after import</label>
          </div>
          {problems.length > 0 && <ul className="rounded bg-bad-soft px-4 py-2 text-sm text-bad">{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
          {missingNotes.length > 0 && <ul className="rounded bg-warn-soft px-4 py-2 text-xs text-[#7a3d06]">{missingNotes.map((p) => <li key={p}>{p}</li>)}</ul>}
          <div className="flex gap-2">
            <button className={cls.btn} onClick={() => { setStep(1); setUp(null); }}>Start over</button>
            <button className={cls.primary} disabled={busy || problems.length > 0 || label.trim().length < 2} onClick={runImport}>{busy ? "Importing…" : "Validate and import"}</button>
          </div>
        </div>
      )}

      {step === 3 && result && (
        <div className="space-y-3 text-sm">
          <p className="font-medium text-good">Imported as a new dataset version{result.activated ? " and made active" : ""}. {result.rawRowsStored.toLocaleString("en-IN")} raw rows preserved.</p>
          <table className="w-full text-xs"><thead><tr className="text-left text-muted"><th>Entity</th><th>Sheet</th><th>Read</th><th>Imported</th><th>Duplicates removed</th><th>Rejected</th></tr></thead>
            <tbody>{Object.entries(result.counts).map(([k, c]) => <tr key={k} className="border-t border-line"><td className="py-1">{k}</td><td>{c.sheet}</td><td>{c.read}</td><td>{c.imported}</td><td>{c.duplicatesRemoved}</td><td className={c.rejected ? "text-bad" : ""}>{c.rejected}</td></tr>)}</tbody></table>
          {result.rejectedSample.length > 0 && <details><summary className="cursor-pointer text-brand">Rejected rows (first 20)</summary><ul className="mt-1 text-xs">{result.rejectedSample.map((r, i) => <li key={i}>{r.sheet} row {r.row}: {r.reason}</li>)}</ul></details>}
          {result.warnings.length > 0 && <ul className="rounded bg-warn-soft px-4 py-2 text-xs text-[#7a3d06]">{result.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
          <p className="text-xs text-muted">Available in this dataset: {Object.entries(result.capabilities).filter(([, v]) => v).map(([k]) => k).join(", ")}. Missing: {Object.entries(result.capabilities).filter(([, v]) => !v).map(([k]) => k).join(", ") || "nothing"}.</p>
          <button className={cls.btn} onClick={() => { setStep(1); setUp(null); setResult(null); }}>Import another file</button>
        </div>
      )}
    </div>
  );
}

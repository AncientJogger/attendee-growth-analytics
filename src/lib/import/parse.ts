import ExcelJS from "exceljs";
import Papa from "papaparse";
import { ENTITIES, ENTITY_KEYS, norm, type DatasetMapping, type EntityKey, type SheetMapping } from "./schema";

export type Cell = string | number | boolean | Date | null;
export interface ParsedSheet {
  name: string;
  headers: string[];
  rows: Cell[][];
}

// Vercel functions accept request bodies up to 4.5 MB; elsewhere allow 15 MB.
export const MAX_UPLOAD_BYTES = process.env.VERCEL ? 4.3 * 1024 * 1024 : 15 * 1024 * 1024;
export const MAX_ROWS_PER_SHEET = 200_000;

/** Turns an ExcelJS cell value into a plain value. Formulas are never evaluated: we keep the stored result. */
function plain(v: unknown): Cell {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("result" in o) return plain(o.result);
    if ("richText" in o && Array.isArray(o.richText)) return (o.richText as { text: string }[]).map((r) => r.text).join("");
    if ("text" in o) return plain(o.text);
    if ("error" in o) return null;
  }
  return String(v);
}

export async function parseUpload(filename: string, bytes: Buffer): Promise<ParsedSheet[]> {
  if (bytes.length > MAX_UPLOAD_BYTES) throw new Error(`File is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);
  const lower = filename.toLowerCase();
  if (lower.endsWith(".csv")) {
    const text = bytes.toString("utf8").replace(/^﻿/, "");
    const res = Papa.parse<string[]>(text, { skipEmptyLines: true });
    const [headers = [], ...rows] = res.data;
    return [{ name: filename.replace(/\.csv$/i, ""), headers: headers.map(String), rows: rows.slice(0, MAX_ROWS_PER_SHEET).map((r) => r.map((c) => (c === "" ? null : c))) }];
  }
  if (!lower.endsWith(".xlsx")) throw new Error("Only .xlsx and .csv files are supported");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes as unknown as ArrayBuffer);
  const sheets: ParsedSheet[] = [];
  wb.eachSheet((ws) => {
    const headerRow = ws.getRow(1);
    const width = ws.actualColumnCount || headerRow.cellCount;
    const headers: string[] = [];
    for (let c = 1; c <= width; c++) headers.push(String(plain(headerRow.getCell(c).value) ?? `column_${c}`));
    const rows: Cell[][] = [];
    ws.eachRow({ includeEmpty: false }, (row, rn) => {
      if (rn === 1 || rows.length >= MAX_ROWS_PER_SHEET) return;
      const vals: Cell[] = [];
      for (let c = 1; c <= width; c++) vals.push(plain(row.getCell(c).value));
      if (vals.some((v) => v !== null && v !== "")) rows.push(vals);
    });
    sheets.push({ name: ws.name, headers, rows });
  });
  return sheets;
}

export interface ColumnProfile {
  header: string;
  inferredType: "number" | "date" | "boolean" | "text" | "empty";
  nullRate: number;
  distinct: number;
  examples: string[];
}

export function profileSheet(s: ParsedSheet): ColumnProfile[] {
  return s.headers.map((h, i) => {
    const vals = s.rows.map((r) => r[i]).filter((v) => v !== null && v !== "");
    const types = new Set(vals.slice(0, 500).map((v) => (v instanceof Date ? "date" : typeof v === "number" ? "number" : typeof v === "boolean" ? "boolean" : "text")));
    const inferredType = vals.length === 0 ? "empty" : types.size === 1 ? ([...types][0] as ColumnProfile["inferredType"]) : "text";
    const distinct = new Set(vals.map((v) => (v instanceof Date ? v.toISOString() : String(v)))).size;
    return {
      header: h,
      inferredType,
      nullRate: s.rows.length ? 1 - vals.length / s.rows.length : 0,
      distinct,
      examples: vals.slice(0, 3).map((v) => (v instanceof Date ? v.toISOString().slice(0, 19).replace("T", " ") : String(v).slice(0, 60))),
    };
  });
}

/** Suggests an entity and column mapping per sheet from sheet names and header synonyms. */
export function suggestMapping(sheets: ParsedSheet[]): DatasetMapping {
  const out: DatasetMapping = { sheets: {} };
  const taken = new Set<EntityKey>();
  const scored = sheets.map((s) => {
    const sname = norm(s.name);
    const scores = ENTITY_KEYS.map((e) => {
      const spec = ENTITIES[e];
      const nameHit = spec.sheetSyn.some((x) => sname === x || sname.replace(/s$/, "") === x.replace(/s$/, "")) ? 3 : spec.sheetSyn.some((x) => sname.includes(x)) ? 1.5 : 0;
      const fields = Object.entries(spec.fields) as [string, { required?: boolean }][];
      const cols = suggestColumns(e, s.headers);
      const req = fields.filter(([, f]) => f.required);
      const reqHit = req.filter(([k]) => cols[k]).length;
      const allHit = fields.filter(([k]) => cols[k]).length;
      const score = nameHit + (req.length ? (2 * reqHit) / req.length : 0) + allHit / fields.length;
      return { e, score, complete: reqHit === req.length, cols };
    });
    return { s, scores: scores.sort((a, b) => b.score - a.score) };
  });
  // Assign highest-confidence sheets first so each entity is used once.
  scored.sort((a, b) => b.scores[0].score - a.scores[0].score);
  for (const { s, scores } of scored) {
    const best = scores.find((x) => !taken.has(x.e) && x.score >= 1.5 && x.complete);
    if (!best) {
      out.sheets[s.name] = { entity: "ignore", columns: {} };
      continue;
    }
    taken.add(best.e);
    out.sheets[s.name] = { entity: best.e, columns: best.cols };
  }
  return out;
}

export function suggestColumns(entity: EntityKey, headers: string[]): SheetMapping["columns"] {
  const normed = headers.map(norm);
  const used = new Set<number>();
  const cols: Record<string, string> = {};
  const fields = Object.entries(ENTITIES[entity].fields) as [string, { syn: string[]; required?: boolean }][];
  // Required fields pick first; within a field, earlier synonyms win.
  fields.sort((a, b) => Number(!!b[1].required) - Number(!!a[1].required));
  for (const [key, f] of fields) {
    for (const syn of f.syn) {
      const idx = normed.findIndex((h, i) => h === syn && !used.has(i));
      if (idx >= 0) {
        cols[key] = headers[idx];
        used.add(idx);
        break;
      }
    }
  }
  // Looser pass: a header that contains a synonym as whole words (e.g. "scan_time" -> "time").
  for (const [key, f] of fields) {
    if (cols[key]) continue;
    for (const syn of f.syn) {
      if (syn.length < 4) continue;
      const idx = normed.findIndex((h, i) => !used.has(i) && (`_${h}_`.includes(`_${syn}_`) || (syn.includes("_") && h.includes(syn))));
      if (idx >= 0) {
        cols[key] = headers[idx];
        used.add(idx);
        break;
      }
    }
  }
  return cols;
}

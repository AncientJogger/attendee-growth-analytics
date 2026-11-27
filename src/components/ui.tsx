import Link from "next/link";
import type { ReactNode } from "react";

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">{title}</h1>
        {subtitle && <div className="mt-1 max-w-3xl text-sm text-muted">{subtitle}</div>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ title, children, actions, className = "", note }: { title?: ReactNode; children: ReactNode; actions?: ReactNode; className?: string; note?: ReactNode }) {
  return (
    <section className={`rounded-xl border border-line bg-white p-5 shadow-[0_1px_2px_rgba(11,31,58,0.04)] ${className}`}>
      {(title || actions) && (
        <div className="mb-3 flex items-start justify-between gap-3">
          {title && <h2 className="text-sm font-semibold text-ink">{title}</h2>}
          {actions}
        </div>
      )}
      {children}
      {note && <p className="mt-3 text-xs leading-relaxed text-muted">{note}</p>}
    </section>
  );
}

export type Tag = "observed" | "calculated" | "estimated" | "recommended" | "assumption";
const TAG_STYLE: Record<Tag, string> = {
  observed: "bg-brand-soft text-brand",
  calculated: "bg-[#eef6f7] text-[#0f6470]",
  estimated: "bg-warn-soft text-warn",
  recommended: "bg-[#f3effb] text-[#5b3aa3]",
  assumption: "bg-[#f1f3f6] text-ink-2",
};
export function EvidenceTag({ tag }: { tag: Tag }) {
  const label = { observed: "Observed", calculated: "Calculated", estimated: "Estimated", recommended: "Recommended", assumption: "Planning assumption" }[tag];
  return <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${TAG_STYLE[tag]}`}>{label}</span>;
}

export function Stat({ label, value, sub, tag, href }: { label: string; value: ReactNode; sub?: ReactNode; tag?: Tag; href?: string }) {
  const body = (
    <div className="h-full rounded-xl border border-line bg-white p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted">{label}</span>
        {tag && <EvidenceTag tag={tag} />}
      </div>
      <div className="mt-2 text-2xl font-semibold tabular-nums text-ink">{value}</div>
      {sub && <div className="mt-1 text-xs text-muted">{sub}</div>}
    </div>
  );
  return href ? <Link href={href} className="block hover:opacity-90">{body}</Link> : body;
}

const HEALTH: Record<string, string> = {
  healthy: "bg-good-soft text-good", attention: "bg-warn-soft text-warn", critical: "bg-bad-soft text-bad", insufficient: "bg-[#f1f3f6] text-muted",
  scale: "bg-good-soft text-good", change: "bg-warn-soft text-warn", stop: "bg-bad-soft text-bad",
};
export function Badge({ kind = "neutral", children }: { kind?: string; children: ReactNode }) {
  const style = HEALTH[kind] ?? (kind === "brand" ? "bg-brand-soft text-brand" : "bg-[#f1f3f6] text-ink-2");
  return <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${style}`}>{children}</span>;
}

export function Table({ head, children, dense }: { head: ReactNode[]; children: ReactNode; dense?: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-line text-xs uppercase tracking-wide text-muted">
            {head.map((h, i) => <th key={i} className={`${dense ? "py-1.5" : "py-2"} pr-4 font-medium`}>{h}</th>)}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">{children}</tbody>
      </table>
    </div>
  );
}
export const Td = ({ children, className = "" }: { children?: ReactNode; className?: string }) => <td className={`py-2 pr-4 align-top ${className}`}>{children}</td>;

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-dashed border-line p-6 text-center text-sm text-muted">{children}</div>;
}

export function Notice({ kind = "info", children }: { kind?: "info" | "warn" | "bad" | "good"; children: ReactNode }) {
  const s = { info: "border-brand/20 bg-brand-soft text-ink-2", warn: "border-warn/30 bg-warn-soft text-[#7a3d06]", bad: "border-bad/30 bg-bad-soft text-bad", good: "border-good/30 bg-good-soft text-good" }[kind];
  return <div className={`rounded-lg border px-4 py-3 text-sm ${s}`}>{children}</div>;
}

export const btn = "inline-flex items-center justify-center gap-1 rounded-lg border border-line bg-white px-3 py-1.5 text-sm font-medium text-ink hover:bg-brand-soft disabled:opacity-50";
export const btnPrimary = "inline-flex items-center justify-center gap-1 rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-[#1e40af] disabled:opacity-50";
export const inputInline = "rounded-lg border border-line bg-white px-2.5 py-1.5 text-sm text-ink focus:border-brand";
export const input = `w-full ${inputInline}`;
export const label = "mb-1 block text-xs font-medium text-muted";

export function Bar({ value, max, tone = "brand" }: { value: number; max: number; tone?: "brand" | "good" | "warn" | "bad" }) {
  const w = max > 0 ? Math.max(2, Math.min(100, (value / max) * 100)) : 0;
  const c = { brand: "bg-brand", good: "bg-good", warn: "bg-warn", bad: "bg-bad" }[tone];
  return <div className="h-2 w-full rounded-full bg-brand-soft" aria-hidden><div className={`h-2 rounded-full ${c}`} style={{ width: `${w}%` }} /></div>;
}

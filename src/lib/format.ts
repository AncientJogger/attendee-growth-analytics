export const fmtInt = (n: number | null | undefined) => (n === null || n === undefined ? "–" : Math.round(n).toLocaleString("en-IN"));
export const fmtInr = (n: number | null | undefined) => (n === null || n === undefined ? "–" : `₹${Math.round(n).toLocaleString("en-IN")}`);
export const fmtPct = (n: number | null | undefined, d = 1) => (n === null || n === undefined ? "–" : `${(n * 100).toFixed(d)}%`);
export const fmtLakh = (n: number | null | undefined) => (n === null || n === undefined ? "–" : `₹${(n / 100000).toLocaleString("en-IN", { maximumFractionDigits: 2 })}L`);
export function fmtDate(d: string | null | undefined) {
  if (!d) return "–";
  const x = new Date(d.length === 10 ? `${d}T00:00:00Z` : d);
  return x.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: d.length === 10 ? "UTC" : "Asia/Kolkata" });
}
export function fmtDateTime(d: string | Date | null | undefined) {
  if (!d) return "–";
  return new Date(d).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" });
}
export const STATUS_LABEL: Record<string, string> = {
  backlog: "Backlog", todo: "To do", in_progress: "In progress", blocked: "Blocked", review: "Review", done: "Done", cancelled: "Cancelled",
};
export const DECISION_LABEL: Record<string, string> = { double_down: "Double down", maintain: "Maintain", staged_pilot: "Staged pilot", deprioritize: "Deprioritise" };

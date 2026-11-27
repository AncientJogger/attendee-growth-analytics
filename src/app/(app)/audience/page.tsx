import { cachedPage } from "@/lib/cache";
import Link from "next/link";
import { Suspense } from "react";
import { pageData } from "@/lib/page";
import { attendanceMetrics, registrationMetrics } from "@/lib/analytics/metrics";
import { externalCond, verifiedCond } from "@/lib/analytics/context";
import { Badge, Card, Empty, PageHeader, Stat, Table, Td, btn, inputInline } from "@/components/ui";
import { ActionForm, AsOfPicker } from "@/components/client";
import { checkInVerificationAction, registrationStatusAction } from "@/app/actions";
import { fmtDate, fmtDateTime, fmtInt, fmtPct } from "@/lib/format";

const PAGE = 50;

export default async function AudiencePage({ searchParams }: PageProps<"/audience">) {
  const sp = await searchParams;
  const tab = sp.tab === "checkins" ? "checkins" : "registrations";
  const search = typeof sp.q === "string" ? sp.q.trim() : "";
  const status = typeof sp.status === "string" ? sp.status : "";
  const page = Math.max(0, Number(sp.page ?? 0) || 0);
  const { s, ctx, data } = await cachedPage(["audience", sp], () => pageData(sp.asof, async (q, ctx) => {
    if (!ctx) return null;
    const reg = await registrationMetrics(q, ctx);
    const att = await attendanceMetrics(q, ctx);
    if (tab === "registrations") {
      const params: unknown[] = [ctx.dv, ctx.asOf, `%${search}%`, PAGE + 1, page * PAGE];
      const rows = await q<{ id: string; reg: string; person: string; person_type: string | null; campaign: string | null; registered_at: Date; status: string | null; attended: boolean }>(
        `select r.id, r.source_id reg, p.source_id person, p.person_type, c.name campaign, r.registered_at,
           (select h.status from registration_status_history h where h.registration_id = r.id and h.effective_at <= $2 order by h.effective_at desc, h.source_id desc limit 1) status,
           exists (select 1 from check_ins ci where ci.person_id = r.person_id and ci.dataset_version_id = $1 and ci.occurred_at <= $2 and ${verifiedCond(ctx, "ci")}) attended
         from registrations r join people p on p.id = r.person_id left join campaigns c on c.id = r.campaign_id
         where r.dataset_version_id = $1 and r.registered_at <= $2 and (r.source_id ilike $3 or p.source_id ilike $3)
         ${status ? `and (select h.status from registration_status_history h where h.registration_id = r.id and h.effective_at <= $2 order by h.effective_at desc, h.source_id desc limit 1) = '${status.replace(/[^a-z_]/g, "")}'` : ""}
         order by r.registered_at desc limit $4 offset $5`, params);
      return { reg, att, rows, checkins: null };
    }
    const checkins = await q<{ id: number; source_id: string; person: string; person_type: string | null; occurred_at: Date; result: string | null; verification: string | null; method: string | null; counts: boolean }>(
      `select c.id, c.source_id, p.source_id person, p.person_type, c.occurred_at, c.result, c.verification, c.method, (${verifiedCond(ctx)} and ${externalCond(ctx)}) counts
       from check_ins c join people p on p.id = c.person_id where c.dataset_version_id = $1 and c.occurred_at <= $2 and (c.source_id ilike $3 or p.source_id ilike $3)
       order by c.occurred_at desc limit $4 offset $5`, [ctx.dv, ctx.asOf, `%${search}%`, PAGE + 1, page * PAGE]);
    return { reg, att, rows: null, checkins };
  }));
  if (!ctx || !data) return <><PageHeader title="Audience & Registrations" /><Empty>No active dataset.</Empty></>;
  const canFixStatus = s.role !== "team_member";
  const canFixCheckins = s.role === "admin";
  const link = (o: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams();
    Object.entries({ tab, q: search || undefined, status: status || undefined, asof: typeof sp.asof === "string" ? sp.asof : undefined, ...o }).forEach(([k, v]) => v !== undefined && v !== "" && p.set(k, String(v)));
    return `/audience?${p.toString()}`;
  };
  const rows = data.rows ?? data.checkins ?? [];
  return (
    <>
      <PageHeader title="Audience & Registrations"
        subtitle={<>Record-level view with pseudonymous IDs only; attendee names and contact details are not shown. Attendance is defined from verified check-ins, not registrations. As of {fmtDate(ctx.asOfDate)}.</>}
        actions={<Suspense><AsOfPicker value={ctx.asOfDate} min={ctx.event?.historyStart} max={ctx.event?.historyEnd} /></Suspense>} />
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Registrations" tag="observed" value={data.reg.available ? fmtInt(data.reg.registrations) : "–"} sub={data.reg.available ? `${fmtInt(data.reg.registeredPeople)} distinct external people` : undefined} />
        {data.reg.available && Object.entries(data.reg.latestStatus).slice(0, 2).map(([k, v]) => <Stat key={k} label={`Latest status: ${k}`} tag="observed" value={fmtInt(v)} />)}
        <Stat label="Unique verified attendees" tag="observed" value={data.att.available ? fmtInt(data.att.uniqueVerifiedAttendees) : "–"} sub={data.att.available ? `${fmtInt(data.att.verifiedAdmissionRows)} verified admission rows` : undefined} />
        <Stat label="Show-up rate" tag="calculated" value={data.reg.available ? fmtPct(data.reg.showRate) : "–"} />
      </div>
      {data.att.available && (
        <Card className="mb-4" title="Daily visits (operational)" note={`${data.att.definition} Daily counts are visits per day; a person who came both days appears on both. Excluded check-in rows: ${fmtInt(data.att.excluded.notAdmittedOrUnverified)} not admitted or unverified, ${fmtInt(data.att.excluded.verifiedButNotExternal)} verified but not external (staff, internal or test).`}>
          <div className="flex flex-wrap gap-6 text-sm">{data.att.byDay.map((d) => <div key={d.day}><div className="text-xs text-muted">{fmtDate(d.day)}</div><div className="text-lg font-semibold tabular-nums">{fmtInt(d.uniquePeople)}</div><div className="text-xs text-muted">{fmtInt(d.admissionRows)} admission rows</div></div>)}</div>
        </Card>
      )}
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div className="flex rounded-lg border border-line bg-white p-0.5 text-sm">
          <Link href={link({ tab: "registrations", page: undefined })} className={`rounded-md px-3 py-1 ${tab === "registrations" ? "bg-brand text-white" : ""}`}>Registrations</Link>
          <Link href={link({ tab: "checkins", page: undefined })} className={`rounded-md px-3 py-1 ${tab === "checkins" ? "bg-brand text-white" : ""}`}>Check-ins</Link>
        </div>
        <form action="/audience" className="flex gap-2">
          <input type="hidden" name="tab" value={tab} />
          {typeof sp.asof === "string" && <input type="hidden" name="asof" value={sp.asof} />}
          <input name="q" defaultValue={search} placeholder="Search registration, check-in or person ID" className={`${inputInline} w-72`} aria-label="Search by ID" />
          {tab === "registrations" && <select name="status" defaultValue={status} className={inputInline} aria-label="Status"><option value="">Any status</option>{["confirmed", "interested", "waitlisted", "cancelled"].map((x) => <option key={x}>{x}</option>)}</select>}
          <button className={btn}>Search</button>
        </form>
      </div>
      <Card>
        {data.rows && (
          <Table head={["Registration", "Person", "Type", "Campaign", "Registered", "Latest status", "Attended", canFixStatus ? "Correct status" : ""]} dense>
            {data.rows.slice(0, PAGE).map((r) => (
              <tr key={r.id}>
                <Td className="font-mono text-xs">{r.reg}</Td><Td className="font-mono text-xs">{r.person}</Td><Td className="text-xs">{r.person_type ?? "–"}</Td>
                <Td className="text-xs">{r.campaign ?? "–"}</Td><Td className="text-xs">{fmtDateTime(r.registered_at)}</Td>
                <Td><Badge kind={r.status === "confirmed" ? "healthy" : r.status === "cancelled" ? "critical" : r.status === "waitlisted" ? "attention" : "neutral"}>{r.status ?? "–"}</Badge></Td>
                <Td>{r.attended ? <Badge kind="healthy">Yes</Badge> : <span className="text-xs text-muted">No</span>}</Td>
                <Td>{canFixStatus && (
                  <ActionForm action={registrationStatusAction} className="flex gap-1" success="Saved">
                    <input type="hidden" name="registrationId" value={r.id} />
                    <select name="status" defaultValue={r.status ?? "confirmed"} className="rounded border border-line px-1 text-xs" aria-label="New status">{["confirmed", "interested", "waitlisted", "cancelled"].map((x) => <option key={x}>{x}</option>)}</select>
                    <input name="reason" required minLength={3} placeholder="Reason" className="w-28 rounded border border-line px-1 text-xs" aria-label="Reason" />
                    <button className="text-xs text-brand">Save</button>
                  </ActionForm>
                )}</Td>
              </tr>
            ))}
          </Table>
        )}
        {data.checkins && (
          <Table head={["Check-in", "Person", "Type", "When", "Result", "Verification", "Method", "Counts toward attendance", canFixCheckins ? "Correct" : ""]} dense>
            {data.checkins.slice(0, PAGE).map((c) => (
              <tr key={c.id}>
                <Td className="font-mono text-xs">{c.source_id}</Td><Td className="font-mono text-xs">{c.person}</Td><Td className="text-xs">{c.person_type ?? "–"}</Td>
                <Td className="text-xs">{fmtDateTime(c.occurred_at)}</Td><Td className="text-xs">{c.result ?? "–"}</Td><Td className="text-xs">{c.verification ?? "–"}</Td><Td className="text-xs">{c.method ?? "–"}</Td>
                <Td>{c.counts ? <Badge kind="healthy">Yes</Badge> : <span className="text-xs text-muted">No</span>}</Td>
                <Td>{canFixCheckins && (
                  <ActionForm action={checkInVerificationAction} className="flex gap-1" success="Saved">
                    <input type="hidden" name="checkInId" value={c.id} />
                    <input type="hidden" name="verification" value={c.verification === "verified" ? "unverified" : "verified"} />
                    <input name="reason" required minLength={3} placeholder="Reason" className="w-24 rounded border border-line px-1 text-xs" aria-label="Reason" />
                    <button className="text-xs text-brand">{c.verification === "verified" ? "Mark unverified" : "Mark verified"}</button>
                  </ActionForm>
                )}</Td>
              </tr>
            ))}
          </Table>
        )}
        {rows.length === 0 && <p className="py-6 text-center text-sm text-muted">No records match.</p>}
        <div className="mt-3 flex justify-between text-sm">
          {page > 0 ? <Link className={btn} href={link({ page: page - 1 })}>← Previous</Link> : <span />}
          {rows.length > PAGE && <Link className={btn} href={link({ page: page + 1 })}>Next →</Link>}
        </div>
      </Card>
    </>
  );
}

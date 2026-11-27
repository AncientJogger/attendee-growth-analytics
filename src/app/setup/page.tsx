import { timingSafeEqual } from "node:crypto";
import { withSystem } from "@/lib/db";
import { btnPrimary, input, label } from "@/components/ui";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// One-time database setup from the deployed app, for hosts where you cannot run the
// npm scripts. Protected by the SETUP_TOKEN environment variable; remove that variable
// after setup to disable this page entirely.

function tokenOk(given: string) {
  const want = process.env.SETUP_TOKEN ?? "";
  if (want.length < 16) return false;
  const a = Buffer.from(given), b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function status() {
  try {
    const [r] = await withSystem((q) => q<{ ws: string | null; people: string | null }>(
      "select (select count(*) from workspaces)::text ws, (select count(*) from people)::text people"));
    return { db: true, workspaces: Number(r.ws), people: Number(r.people) };
  } catch (e) {
    const msg = (e as Error).message;
    return { db: !/relation .* does not exist/.test(msg) ? false : true, workspaces: 0, people: 0, error: /does not exist/.test(msg) ? null : msg };
  }
}

export default async function SetupPage({ searchParams }: PageProps<"/setup">) {
  const sp = await searchParams;
  if (!process.env.SETUP_TOKEN) {
    return <main className="mx-auto max-w-xl p-10 text-sm"><h1 className="text-xl font-semibold">Setup is disabled</h1><p className="mt-2 text-muted">Set a SETUP_TOKEN environment variable (16+ characters) and redeploy to enable one-time setup.</p></main>;
  }
  const st = await status();

  async function runSetup(fd: FormData) {
    "use server";
    const { redirect } = await import("next/navigation");
    if (!tokenOk(String(fd.get("token") ?? ""))) redirect("/setup?result=badtoken");
    const reset = fd.get("reset") === "on";
    let outcome = "ok";
    try {
      const { seed } = await import("../../../scripts/seed");
      await seed({ reset, quiet: true });
    } catch (e) {
      console.error(e);
      outcome = `error:${String((e as Error).message).slice(0, 300)}`;
    }
    redirect(`/setup?result=${encodeURIComponent(outcome)}`);
  }

  const result = typeof sp.result === "string" ? sp.result : null;
  return (
    <main className="mx-auto max-w-xl p-10 text-sm">
      <h1 className="text-xl font-semibold text-ink">One-time setup</h1>
      <p className="mt-2 text-muted">Creates the tables and security policies, then imports the supplied attendee dataset and the demo workspace. Running it again does nothing unless you tick “Rebuild”.</p>
      <div className="mt-4 rounded-lg border border-line bg-white p-4">
        <p><b>Database connection:</b> {st.db ? "OK" : <span className="text-bad">failed{st.error ? `: ${st.error}` : ""}</span>}</p>
        <p><b>Workspaces:</b> {st.workspaces} · <b>People records:</b> {st.people}</p>
      </div>
      {result === "ok" && <p className="mt-4 rounded bg-good-soft px-3 py-2 text-good">Setup finished. <a className="underline" href="/login">Go to sign in</a>. Remove SETUP_TOKEN from Vercel when you are done.</p>}
      {result === "badtoken" && <p className="mt-4 rounded bg-bad-soft px-3 py-2 text-bad">That setup token is wrong.</p>}
      {result?.startsWith("error:") && <p className="mt-4 rounded bg-bad-soft px-3 py-2 text-bad">Setup failed: {result.slice(6)}</p>}
      <form action={runSetup} className="mt-6 space-y-3">
        <div><label className={label} htmlFor="token">Setup token</label><input id="token" name="token" type="password" required className={input} /></div>
        <label className="flex items-center gap-2"><input type="checkbox" name="reset" /> Rebuild the demo workspace (keeps the audit log)</label>
        <button className={btnPrimary}>Run setup</button>
        <p className="text-xs text-muted">This can take up to a minute.</p>
      </form>
    </main>
  );
}

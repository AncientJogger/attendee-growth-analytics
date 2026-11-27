import { redirect } from "next/navigation";
import { getSession, startSession, verifyPassword } from "@/lib/auth";
import { btnPrimary, input, label } from "@/components/ui";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // first sign-in can include one-time database setup

async function login(formData: FormData) {
  "use server";
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const id = await verifyPassword(email, password);
  if (!id) redirect("/login?error=1");
  await startSession(id);
  redirect("/overview");
}

// Only listed when SHOW_DEMO_LOGINS=true (off by default, so the sign-in page stays clean).
const DEMO = [
  { role: "Admin", email: "admin@demo.fest", password: "Demo-Admin-2026" },
  { role: "Campaign Manager", email: "meera@demo.fest", password: "Demo-Manager-2026" },
  { role: "Team Member", email: "dev@demo.fest", password: "Demo-Member-2026" },
];

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  if (await getSession()) redirect("/overview");
  const sp = await searchParams;
  const showDemo = process.env.SHOW_DEMO_LOGINS === "true";
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f6f8fb] px-6 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand text-white shadow-sm" aria-hidden>
            <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 19V11M10 19V6M16 19v-5M22 19H2" />
            </svg>
          </div>
          <h1 className="mt-4 text-2xl font-semibold tracking-tight text-ink">Fest Growth Analytics</h1>
          <p className="mt-1 text-sm text-muted">Sign in to your workspace</p>
        </div>

        <form action={login} className="rounded-2xl border border-line bg-white p-6 shadow-[0_4px_24px_rgba(11,31,58,0.06)]">
          {sp.error && <p className="mb-4 rounded-lg bg-bad-soft px-3 py-2 text-sm text-bad">Email or password is incorrect.</p>}
          <div>
            <label className={label} htmlFor="email">Email</label>
            <input id="email" name="email" type="email" autoComplete="email" required className={input} />
          </div>
          <div className="mt-4">
            <label className={label} htmlFor="password">Password</label>
            <input id="password" name="password" type="password" autoComplete="current-password" required className={input} />
          </div>
          <button className={`${btnPrimary} mt-6 w-full`}>Sign in</button>
        </form>

        {showDemo && (
          <details className="mt-4 rounded-xl border border-line bg-white px-4 py-3 text-sm">
            <summary className="cursor-pointer text-muted">Demo accounts</summary>
            <ul className="mt-2 space-y-1">
              {DEMO.map((d) => (
                <li key={d.email} className="text-ink-2">
                  <span className="font-medium text-ink">{d.role}</span> · <code>{d.email}</code> · <code>{d.password}</code>
                </li>
              ))}
            </ul>
          </details>
        )}

        <p className="mt-8 text-center text-xs text-muted">Attendee funnel, campaigns, tasks and an AI analyst in one place.</p>
      </div>
    </main>
  );
}

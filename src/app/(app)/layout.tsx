import { cachedPage } from "@/lib/cache";
import Link from "next/link";
import { Suspense } from "react";
import { requireSession, ROLE_LABEL } from "@/lib/auth";
import { withUser } from "@/lib/db";
import { logout } from "@/app/actions";
import { LiveRefresh } from "@/components/client";
import { NavLinks } from "@/components/nav";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // first sign-in can include one-time database setup

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const s = await requireSession();
  const [info] = await cachedPage(["layout"], () => withUser(s, (q) => q<{ data_version: string; label: string | null; is_demo: boolean | null; pending: string }>(
    `select w.data_version, dv.label, dv.is_demo, (select count(*) from approvals a where a.workspace_id = w.id and a.status = 'pending') pending
     from workspaces w left join dataset_versions dv on dv.id = w.active_dataset_version_id where w.id = $1`, [s.workspaceId])));
  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-line bg-white lg:flex">
        <div className="px-5 py-5">
          <Link href="/overview" className="block">
            <span className="text-[15px] font-semibold tracking-tight text-ink">Fest Growth Analytics</span>
            <span className="mt-0.5 block text-xs text-muted">Attendee growth board</span>
          </Link>
        </div>
        <NavLinks role={s.role} pending={Number(info?.pending ?? 0)} />
        <div className="mt-auto border-t border-line px-5 py-4 text-xs text-muted">
          <div className="font-medium text-ink">{s.name}</div>
          <div>{ROLE_LABEL[s.role]}</div>
          <form action={logout}><button className="mt-2 text-brand hover:underline">Sign out</button></form>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-white/95 px-6 py-3 backdrop-blur">
          <div className="lg:hidden"><Link href="/overview" className="font-semibold text-ink">Fest Growth Analytics</Link></div>
          <div className="flex min-w-0 items-center gap-2 text-xs">
            <span className="text-muted">Active dataset</span>
            <Link href="/datasets" className="truncate rounded-md bg-brand-soft px-2 py-1 font-medium text-brand">{info?.label ?? "None loaded"}</Link>
            {info?.is_demo && <span className="rounded bg-[#f1f3f6] px-1.5 py-0.5 text-[10px] font-semibold uppercase text-muted">Historical demo</span>}
          </div>
          <div className="ml-auto flex items-center gap-4">
            <Suspense><LiveRefresh initial={Number(info?.data_version ?? 0)} /></Suspense>
            <span className="hidden text-xs text-muted sm:inline">{s.name} · {ROLE_LABEL[s.role]}</span>
          </div>
        </header>
        <div className="border-b border-line bg-white px-4 py-2 lg:hidden"><NavLinks role={s.role} pending={Number(info?.pending ?? 0)} compact /></div>
        <main className="mx-auto w-full max-w-[1400px] flex-1 px-6 py-6">{children}</main>
      </div>
    </div>
  );
}

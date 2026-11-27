"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/overview", label: "Overview" },
  { href: "/campaigns", label: "Campaigns" },
  { href: "/initiatives", label: "Initiatives" },
  { href: "/audience", label: "Audience & Registrations" },
  { href: "/funnel", label: "Funnel & Attribution" },
  { href: "/team", label: "Team" },
  { href: "/tasks", label: "Tasks & Calendar" },
  { href: "/budget", label: "Budget" },
  { href: "/experiments", label: "Experiments" },
  { href: "/analyst", label: "AI Growth Analyst" },
  { href: "/approvals", label: "Approvals" },
  { href: "/strategy", label: "Strategy & Targets" },
  { href: "/datasets", label: "Dataset Manager" },
  { href: "/audit", label: "Audit log" },
];

export function NavLinks({ role, pending, compact }: { role: string; pending: number; compact?: boolean }) {
  const path = usePathname();
  const items = ITEMS.filter((i) => role === "admin" || i.href !== "/audit");
  if (compact) {
    return (
      <nav className="flex gap-1 overflow-x-auto text-xs" aria-label="Main">
        {items.map((i) => (
          <Link key={i.href} href={i.href} className={`whitespace-nowrap rounded-md px-2 py-1 ${path.startsWith(i.href) ? "bg-brand-soft font-medium text-brand" : "text-ink-2"}`}>{i.label}</Link>
        ))}
      </nav>
    );
  }
  return (
    <nav className="flex flex-col gap-0.5 px-3" aria-label="Main">
      {items.map((i) => {
        const active = path.startsWith(i.href);
        return (
          <Link key={i.href} href={i.href} aria-current={active ? "page" : undefined}
            className={`flex items-center justify-between rounded-lg px-3 py-1.5 text-sm ${active ? "bg-brand-soft font-medium text-brand" : "text-ink-2 hover:bg-[#f4f6fa]"}`}>
            {i.label}
            {i.href === "/approvals" && pending > 0 && <span className="rounded-full bg-warn px-1.5 text-[10px] font-semibold text-white">{pending}</span>}
          </Link>
        );
      })}
    </nav>
  );
}

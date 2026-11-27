"use client";
import { useEffect, useRef, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/** Polls the workspace data version and refreshes server data when anything changes. */
export function LiveRefresh({ initial }: { initial: number }) {
  const router = useRouter();
  const last = useRef(initial);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    last.current = initial;
  }, [initial]);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch("/api/version", { cache: "no-store" });
        if (!r.ok) return;
        const { v } = await r.json();
        if (alive && typeof v === "number" && v !== last.current) {
          last.current = v;
          setFlash(true);
          router.refresh();
          setTimeout(() => setFlash(false), 2500);
        }
      } catch {
        /* offline: try again next tick */
      }
    };
    const id = setInterval(tick, 4000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [router]);
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs ${flash ? "text-good" : "text-muted"}`} aria-live="polite">
      <span className={`h-1.5 w-1.5 rounded-full ${flash ? "bg-good" : "bg-[#9fb0c8]"}`} />
      {flash ? "Updated just now" : "Live"}
    </span>
  );
}

export function AsOfPicker({ value, min, max }: { value: string; min?: string | null; max?: string | null }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  return (
    <label className="flex items-center gap-2 text-xs text-muted">
      As of
      <input
        type="date"
        value={value}
        min={min ?? undefined}
        max={max ?? undefined}
        onChange={(e) => {
          const p = new URLSearchParams(sp.toString());
          if (e.target.value) p.set("asof", e.target.value);
          else p.delete("asof");
          router.push(`${pathname}?${p.toString()}`);
        }}
        className="rounded-md border border-line bg-white px-2 py-1 text-xs text-ink"
      />
    </label>
  );
}

/** Submits a server action and shows its error or success message inline. */
export function ActionForm({ action, children, className = "", success = "Saved", resetOnSuccess = false }: {
  action: (fd: FormData) => Promise<{ ok: boolean; error?: string; message?: string } | void>;
  children: React.ReactNode; className?: string; success?: string; resetOnSuccess?: boolean;
}) {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const ref = useRef<HTMLFormElement>(null);
  return (
    <form
      ref={ref}
      className={className}
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        start(async () => {
          const res = await action(fd);
          if (res && !res.ok) setMsg({ ok: false, text: res.error ?? "Something went wrong" });
          else {
            setMsg({ ok: true, text: (res && res.message) || success });
            if (resetOnSuccess) ref.current?.reset();
          }
        });
      }}
    >
      <fieldset disabled={pending} className="contents">{children}</fieldset>
      {msg && <p role="status" className={`mt-2 text-xs ${msg.ok ? "text-good" : "text-bad"}`}>{msg.text}</p>}
    </form>
  );
}

/** A select that saves immediately when changed (used for task status on boards and lists). */
export function AutoSelect({ action, name, value, options, hidden }: {
  action: (fd: FormData) => Promise<{ ok: boolean; error?: string } | void>;
  name: string; value: string; options: { value: string; label: string }[]; hidden: Record<string, string>;
}) {
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  return (
    <span className="inline-flex flex-col">
      <select
        aria-label={name}
        defaultValue={value}
        disabled={pending}
        className="rounded-md border border-line bg-white px-1.5 py-0.5 text-xs"
        onChange={(e) => {
          const fd = new FormData();
          Object.entries(hidden).forEach(([k, v]) => fd.set(k, v));
          fd.set(name, e.target.value);
          start(async () => {
            const r = await action(fd);
            setErr(r && !r.ok ? r.error ?? "Failed" : null);
          });
        }}
      >
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {err && <span className="mt-0.5 max-w-48 text-[11px] text-bad">{err}</span>}
    </span>
  );
}

"use client";
/** Small shared pieces of the console: the Baton mark, a live dot, eyebrow headers, timecodes, the theme toggle. */
import { MoonIcon, SunIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { formatCallClock, formatMmSs } from "@/client/store/selectors";
import { cn } from "@/lib/utils";

export function BatonMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={cn("size-7", className)}>
      <defs>
        <linearGradient id="bt-mark-g" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="var(--rep)" />
          <stop offset="1" stopColor="var(--ai)" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="8" fill="var(--bt-ink)" />
      <rect x="6.5" y="13.5" width="19" height="5" rx="2.5" transform="rotate(-32 16 16)" fill="url(#bt-mark-g)" />
      <circle cx="9.3" cy="21.6" r="2.1" fill="var(--rep)" />
      <circle cx="22.7" cy="10.4" r="2.1" fill="var(--ai)" />
    </svg>
  );
}

export function LiveDot({ className, pulse = true }: { className?: string; pulse?: boolean }) {
  return <span aria-hidden="true" className={cn("bt-dot", pulse && "bt-dot-pulse", className)} />;
}

export function Eyebrow({ children, className, as: As = "h2", id }: { children: ReactNode; className?: string; as?: "h2" | "h3" | "p" | "span"; id?: string }) {
  return (
    <As id={id} className={cn("bt-eyebrow", className)}>
      {children}
    </As>
  );
}

export function Timecode({ ms, precise = false, className }: { ms: number | null | undefined; precise?: boolean; className?: string }) {
  return <span className={cn("bt-mono text-[0.8em]", className)}>{precise ? formatCallClock(ms) : formatMmSs(ms)}</span>;
}

export function ThemeToggle() {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    let initial = false;
    try {
      const saved = localStorage.getItem("baton-theme");
      initial = saved ? saved === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
    } catch {
      initial = false;
    }
    setDark(initial);
    document.documentElement.classList.toggle("dark", initial);
  }, []);
  const flip = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("baton-theme", next ? "dark" : "light");
    } catch {
      /* private mode: the toggle still works for this page view */
    }
  };
  return (
    <button
      type="button"
      onClick={flip}
      className="inline-flex size-8 items-center justify-center rounded-md border border-(--bt-line) text-(--bt-muted) hover:text-(--bt-ink) focus-visible:ring-2 focus-visible:ring-(--ai) focus-visible:outline-none"
      aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
    >
      {dark ? <SunIcon className="size-4" aria-hidden="true" /> : <MoonIcon className="size-4" aria-hidden="true" />}
    </button>
  );
}

/** A labelled key-value in the console's display face. */
export function Stat({ label, value, sub, className }: { label: string; value: ReactNode; sub?: ReactNode; className?: string }) {
  return (
    <div className={cn("min-w-0", className)}>
      <div className="bt-eyebrow">{label}</div>
      <div className="bt-display bt-num text-lg leading-tight font-semibold">{value}</div>
      {sub ? <div className="text-xs text-(--bt-muted)">{sub}</div> : null}
    </div>
  );
}

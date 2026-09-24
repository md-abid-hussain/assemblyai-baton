import { twMerge } from "tailwind-merge";

/** A class value as accepted by `cn()` (the clsx subset shadcn components use). */
export type ClassValue = string | number | bigint | boolean | null | undefined | ClassValue[] | Record<string, unknown>;

function flatten(v: ClassValue, out: string[]): void {
  if (!v && v !== 0) return;
  if (typeof v === "string" || typeof v === "number" || typeof v === "bigint") {
    out.push(String(v));
  } else if (Array.isArray(v)) {
    for (const x of v) flatten(x, out);
  } else if (typeof v === "object") {
    for (const [k, on] of Object.entries(v)) if (on) out.push(k);
  }
}

/** Merge class names (clsx semantics + tailwind-merge conflict resolution). Used by every shadcn component. */
export function cn(...inputs: ClassValue[]): string {
  const out: string[] = [];
  for (const v of inputs) flatten(v, out);
  return twMerge(out.join(" "));
}

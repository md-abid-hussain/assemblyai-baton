/**
 * app/call/call-entry.ts - server-side lookup of a call in the generated manifest (src/generated/calls.json, WP9).
 * Reads the file at request time so the page builds before WP9's manifest exists. At G1 the integrator may swap this
 * for WP2's `getCallEntry` (src/server/runs/calls.ts); the page only needs `{ entry, featuredId }`.
 */
import "server-only";

import { readFile } from "node:fs/promises";
import path from "node:path";

import { CallManifestEntrySchema, type CallManifestEntry } from "@/core/contracts/scenario";

let cache: CallManifestEntry[] | null = null;

async function manifest(): Promise<CallManifestEntry[]> {
  if (cache) return cache;
  try {
    const raw = JSON.parse(await readFile(path.join(process.cwd(), "src", "generated", "calls.json"), "utf8")) as unknown;
    const list = Array.isArray(raw) ? raw : ((raw as { calls?: unknown[] } | null)?.calls ?? []);
    cache = list.flatMap((x) => {
      const r = CallManifestEntrySchema.safeParse(x);
      return r.success ? [r.data] : [];
    });
  } catch {
    cache = [];
  }
  return cache;
}

export async function lookupCall(callId: string | null): Promise<{ entry: CallManifestEntry | null; featuredId: string | null; known: boolean }> {
  const list = await manifest();
  const featured = list.find((c) => c.featured) ?? null;
  const entry = callId ? (list.find((c) => c.callId === callId) ?? null) : null;
  return { entry, featuredId: featured?.callId ?? null, known: list.length > 0 };
}

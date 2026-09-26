/**
 * app/call/call-entry.ts - server-side lookup of a call in the generated manifest (src/generated/calls.json, WP9)
 * and of how that call's audio was made (src/generated/call-provenance.json).
 *
 * Both files are read at request time, so the page builds before WP9's manifest exists. At G1 the integrator may
 * swap the manifest lookup for WP2's `getCallEntry` (src/server/runs/calls.ts); the page only needs
 * `{ entry, featuredId }` and the provenance entry.
 *
 * The provenance file is the only record of how a take was made: a simulated take must never reach the console
 * labelled as a recording (PLATFORM §7.6; `ext/wp9-data.ts`: read `file[callId]?.humanHalf ?? "recorded"`).
 */
import "server-only";

import { readFile } from "node:fs/promises";
import path from "node:path";

import { CallProvenanceFileSchema, type CallProvenanceEntry } from "@/core/contracts/ext/wp9-data";
import { CallManifestEntrySchema, type CallManifestEntry } from "@/core/contracts/scenario";

let cache: CallManifestEntry[] | null = null;
let provenanceCache: Record<string, CallProvenanceEntry> | null = null;

async function manifest(): Promise<CallManifestEntry[]> {
  if (cache) return cache;
  try {
    const raw = JSON.parse(await readFile(path.join(process.cwd(), "src", "generated", "calls.json"), "utf8")) as unknown;
    const list = Array.isArray(raw) ? raw : ((raw as { calls?: unknown[] } | null)?.calls ?? []);
    const parsed = list.flatMap((x) => {
      const r = CallManifestEntrySchema.safeParse(x);
      return r.success ? [r.data] : [];
    });
    if (parsed.length > 0) cache = parsed; // an empty or missing manifest is re-read on the next request
    return parsed;
  } catch {
    return [];
  }
}

/** `src/generated/call-provenance.json` for one call, or null when the file (or the entry) is absent. */
export async function lookupProvenance(callId: string | null): Promise<{ humanHalf: "recorded" | "simulated"; detail: string } | null> {
  if (!callId) return null;
  if (!provenanceCache) {
    try {
      const raw: unknown = JSON.parse(await readFile(path.join(process.cwd(), "src", "generated", "call-provenance.json"), "utf8"));
      const parsed = CallProvenanceFileSchema.safeParse(raw);
      if (!parsed.success) return null;
      provenanceCache = parsed.data;
    } catch {
      return null; // no file yet: the server's own strip stands
    }
  }
  const e = provenanceCache[callId];
  return e ? { humanHalf: e.humanHalf, detail: e.detail } : null;
}

export async function lookupCall(callId: string | null): Promise<{ entry: CallManifestEntry | null; featuredId: string | null; known: boolean }> {
  const list = await manifest();
  const featured = list.find((c) => c.featured) ?? null;
  const entry = callId ? (list.find((c) => c.callId === callId) ?? null) : null;
  return { entry, featuredId: featured?.callId ?? null, known: list.length > 0 };
}

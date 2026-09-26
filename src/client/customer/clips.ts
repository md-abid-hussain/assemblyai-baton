/**
 * client/customer/clips.ts - where a customer phrase's audio comes from, and how it is fetched (DESIGN §5.15).
 *
 * Two sources, tried in order (recorded voice first, per §5.15 "Audio"):
 *   1. the committed chip pack `public/tts/manifest.json` (Baton takes; a tail-pack clip is marked `recorded`),
 *   2. a simulated call's `aiClips`, keyed by suggestion kind (PLATFORM §7.5 step 5).
 * Nothing here ever synthesizes: `/api/tts` is cut, so a phrase with no clip simply has no audio and the chip is
 * dropped from the list rather than pretending (DESIGN §7.5 "always labelled; never pretend").
 *
 * All clips are raw PCM16 LE mono at 24 kHz and are fed to the Voice Agent feeder as-is.
 */
import "client-only";

import { bytesToPcm16 } from "@/core/audio";
import type { SimAiClipRef } from "@/core/contracts/ext/wp17-sim";
import type { Suggestion } from "@/core/contracts/services";

import { chipClipUrl, normalizeChipText, type ChipManifest } from "./manifest";

/** One playable customer phrase. `text` is authoritative: it is what the judge will actually hear. */
export interface CustomerClipRef {
  text: string;
  durationMs: number;
  url: string;
  voice: "recorded" | "synthetic";
}

/** A resolved phrase source. Both lookups are synchronous over an already-loaded index. */
export interface ClipIndex {
  /** By suggestion kind (+ the classified field for `answer`): the sim path. */
  byKind(kind: Suggestion["kind"], field: string | null): CustomerClipRef | null;
  /** By phrase: the committed chip pack. */
  byText(text: string): CustomerClipRef | null;
  /** True once something is actually in the index (an empty index must not filter every chip away). */
  readonly size: number;
}

export const EMPTY_CLIP_INDEX: ClipIndex = { byKind: () => null, byText: () => null, size: 0 };

/** `SimAiClips` keys: `confirm` | `consent` | `close` | `answer:<field>` (wp17-sim.ts). */
export function simClipKey(kind: Suggestion["kind"], field: string | null): string | null {
  switch (kind) {
    case "confirm":
      return "confirm";
    case "consent":
      return "consent";
    case "close":
      return "close";
    case "answer":
      return field ? `answer:${field}` : null;
    default:
      return null; // handback / repeat / try / other have no pre-generated sim clip
  }
}

/** The AI-half clips of a simulated call (`SimCallResolution.aiClips`). */
export function createSimClipIndex(aiClips: Readonly<Record<string, SimAiClipRef>>): ClipIndex {
  const byTextKey = new Map<string, CustomerClipRef>();
  const refOf = (c: SimAiClipRef): CustomerClipRef => ({ text: c.text, durationMs: c.durationMs, url: c.url, voice: "synthetic" });
  for (const c of Object.values(aiClips)) byTextKey.set(normalizeChipText(c.text), refOf(c));
  return {
    byKind(kind, field) {
      const key = simClipKey(kind, field);
      const c = key ? aiClips[key] : undefined;
      return c ? refOf(c) : null;
    },
    byText: (text) => byTextKey.get(normalizeChipText(text)) ?? null,
    size: Object.keys(aiClips).length,
  };
}

/**
 * The committed chip pack for one Baton take. A take the pack was not generated for resolves NOTHING: another
 * take's truth is not this take's truth, and a wrong-scenario phrase must never be spoken.
 */
export function createChipIndex(manifest: ChipManifest, callId: string): ChipIndex {
  const call = manifest.calls[callId] ?? null;
  const allowed = new Set(call?.clips ?? []);
  const byTextKey = new Map<string, CustomerClipRef>();
  for (const c of manifest.clips) {
    if (!allowed.has(c.hash)) continue;
    byTextKey.set(normalizeChipText(c.text), { text: c.text, durationMs: c.durationMs, url: chipClipUrl(c.hash), voice: c.voice });
  }
  return {
    byKind: () => null,
    byText: (text) => byTextKey.get(normalizeChipText(text)) ?? null,
    size: byTextKey.size,
    truth: (call?.truth ?? {}) as Partial<Record<string, string>>,
  };
}

export type ChipIndex = ClipIndex & { readonly truth: Partial<Record<string, string>> };

/** First hit wins, so a recorded tail pack is listed before the synthetic pack. */
export function chainClipIndexes(...parts: readonly ClipIndex[]): ClipIndex {
  const live = parts.filter((p) => p.size > 0);
  return {
    byKind(kind, field) {
      for (const p of live) {
        const r = p.byKind(kind, field);
        if (r) return r;
      }
      return null;
    },
    byText(text) {
      for (const p of live) {
        const r = p.byText(text);
        if (r) return r;
      }
      return null;
    },
    get size() {
      return live.reduce((n, p) => n + p.size, 0);
    },
  };
}

// ---------------------------------------------------------------------------------------------- fetching

export interface ClipLoaderDeps {
  fetchImpl?: typeof fetch;
  log?: (level: "warn", msg: string, data?: Record<string, unknown>) => void;
  /** Cap the decoded cache (clips are ~2-3 s = ~100-150 kB each). */
  maxCached?: number;
}

export interface ClipLoader {
  /** Decoded 24 kHz PCM16, cached per URL. Resolves null when the clip cannot be fetched (never throws). */
  load(ref: CustomerClipRef): Promise<Int16Array | null>;
  /** Fetch without waiting for it (autopilot warms the likely next clip). */
  warm(ref: CustomerClipRef): void;
}

export function createClipLoader(d: ClipLoaderDeps = {}): ClipLoader {
  const doFetch = d.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const max = d.maxCached ?? 32;
  const cache = new Map<string, Promise<Int16Array | null>>();

  const fetchOne = async (ref: CustomerClipRef): Promise<Int16Array | null> => {
    try {
      const r = await doFetch(ref.url, { cache: "force-cache" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const buf = await r.arrayBuffer();
      if (buf.byteLength < 2) throw new Error("empty clip");
      return bytesToPcm16(new Uint8Array(buf));
    } catch (e) {
      d.log?.("warn", "customer clip unavailable", { url: ref.url, error: e instanceof Error ? e.message : String(e) });
      return null;
    }
  };

  const get = (ref: CustomerClipRef): Promise<Int16Array | null> => {
    const hit = cache.get(ref.url);
    if (hit) return hit;
    const p = fetchOne(ref);
    cache.set(ref.url, p);
    void p.then((v) => {
      if (v === null) cache.delete(ref.url); // a later click retries
    });
    while (cache.size > max) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined || oldest === ref.url) break;
      cache.delete(oldest);
    }
    return p;
  };

  return { load: get, warm: (ref) => void get(ref) };
}

/** Fetch + validate the committed chip pack. A missing or broken pack is not fatal: the sim path still works. */
export async function loadChipManifest(
  url: string,
  parse: (raw: unknown) => ChipManifest,
  d: { fetchImpl?: typeof fetch; log?: (level: "warn", msg: string, data?: Record<string, unknown>) => void } = {},
): Promise<ChipManifest | null> {
  const doFetch = d.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  try {
    const r = await doFetch(url, { cache: "force-cache" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return parse(await r.json());
  } catch (e) {
    d.log?.("warn", "chip clip pack unavailable", { url, error: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

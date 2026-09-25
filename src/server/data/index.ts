import "server-only";

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { PolicyRecord } from "../../core/contracts/case";
import {
  CachedTurnsFileSchema, ExtractCacheFileSchema, type CachedTurnsFile, type ExtractCacheFile,
} from "../../core/contracts/eval";
import { CallManifestEntrySchema, type CallManifestEntry } from "../../core/contracts/scenario";
import { cachedTurnIdOf, type TurnInput } from "../../core/contracts/turns";
import { log } from "../log";
import { policyFromKitScenario } from "./kit-policy";

/**
 * Server-side data files WP3 serves (src/server/data/**, WP3):
 * - the call manifest (`src/generated/calls.json`, WP9) → route #3 `call`, `assets`; also WP2's call lookup;
 * - scenario policies (`src/generated/scenarios.json`, WP9; fallback: the kit files `data/scenarios/sNN.json`);
 * - the extraction cache `data/cache/extract/<callId>/v3.pc_ctx.json` (WP9) → Express prefill and cached events for
 *   `source:"stt_cache"` turns (DESIGN §5.1.6, §5.1.10), served only when its `extractorVersion` equals ours;
 * - the cached turns `public/data/cached-turns/<callId>.json` (WP9) → `cachedTurnsUrl` and the prefill's turn text.
 *
 * `src/generated/*.json` is meant to be statically IMPORTED (DESIGN §3.1: "imported, never fs-read") because
 * `src/` is not in the deploy bundle. A static import of a file that does not exist yet breaks the build, so the
 * generated data is REGISTERED (`registerGenerated`, G1 wiring in wp3-to-integrator.md); until then a dev-only fs
 * fallback reads it. Every file is read once and cached per process.
 */

export interface GeneratedScenario {
  id: string;
  policy: PolicyRecord;
}

export interface CaseDataSource {
  getCall(callId: string): Promise<CallManifestEntry | null>;
  /** The landing default (`featured: true`), used when route #3 gets no callId. */
  featuredCall(): Promise<CallManifestEntry | null>;
  getPolicy(scenarioId: string): Promise<PolicyRecord | null>;
  /** v3.pc_ctx extraction cache of a call, or null. */
  getExtractCache(callId: string): Promise<ExtractCacheFile | null>;
  getCachedTurns(callId: string): Promise<CachedTurnsFile | null>;
  /** `/data/cached-turns/<callId>.json` when published, else null. */
  cachedTurnsUrl(callId: string): Promise<string | null>;
}

const dataLog = log.child({ component: "data" });

type Loaded<T> = { value: T | null; at: number };

export class FsCaseDataSource implements CaseDataSource {
  private calls: CallManifestEntry[] | null = null;
  private scenarios: Map<string, PolicyRecord> | null = null;
  private readonly files = new Map<string, Promise<Loaded<unknown>>>();

  constructor(private readonly root: string = process.cwd()) {}

  /** G1: the statically imported generated files (see wp3-to-integrator.md). */
  register(g: { calls?: unknown[]; scenarios?: unknown[] }): void {
    if (g.calls) this.calls = g.calls.map((c) => CallManifestEntrySchema.parse(c));
    if (g.scenarios) {
      this.scenarios = new Map();
      for (const s of g.scenarios as GeneratedScenario[]) if (s && typeof s.id === "string" && s.policy) this.scenarios.set(s.id, s.policy);
    }
  }

  private async json(rel: string): Promise<unknown | null> {
    let p = this.files.get(rel);
    if (!p) {
      p = (async () => {
        const abs = join(this.root, rel);
        if (!existsSync(abs)) return { value: null, at: Date.now() };
        try {
          return { value: JSON.parse(await readFile(abs, "utf8")) as unknown, at: Date.now() };
        } catch (err) {
          dataLog.warn("data file unreadable", { file: rel, err });
          return { value: null, at: Date.now() };
        }
      })();
      this.files.set(rel, p);
    }
    return (await p).value;
  }

  private async manifest(): Promise<CallManifestEntry[]> {
    if (this.calls) return this.calls;
    const raw = await this.json("src/generated/calls.json");
    const list = Array.isArray(raw) ? raw : Array.isArray((raw as { calls?: unknown[] } | null)?.calls) ? (raw as { calls: unknown[] }).calls : [];
    const out: CallManifestEntry[] = [];
    for (const c of list) {
      const r = CallManifestEntrySchema.safeParse(c);
      if (r.success) out.push(r.data);
    }
    this.calls = out;
    return out;
  }

  async getCall(callId: string): Promise<CallManifestEntry | null> {
    return (await this.manifest()).find((c) => c.callId === callId) ?? null;
  }

  async featuredCall(): Promise<CallManifestEntry | null> {
    const m = await this.manifest();
    return m.find((c) => c.featured) ?? null;
  }

  async getPolicy(scenarioId: string): Promise<PolicyRecord | null> {
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(scenarioId)) return null;
    const registered = (): PolicyRecord | undefined => this.scenarios?.get(scenarioId);
    if (registered()) return registered()!;
    if (!this.scenarios) {
      const gen = await this.json("src/generated/scenarios.json");
      const list = Array.isArray(gen) ? gen : [];
      if (list.length) this.register({ scenarios: list });
      if (registered()) return registered()!;
    }
    const kit = await this.json(`data/scenarios/${scenarioId}.json`);
    if (!kit) return null;
    try {
      return policyFromKitScenario(kit);
    } catch (err) {
      dataLog.warn("kit scenario did not map to a policy", { scenarioId, err });
      return null;
    }
  }

  async getExtractCache(callId: string): Promise<ExtractCacheFile | null> {
    if (!safeId(callId)) return null;
    const raw = await this.json(`data/cache/extract/${callId}/v3.pc_ctx.json`);
    if (!raw) return null;
    const r = ExtractCacheFileSchema.safeParse(raw);
    if (!r.success) {
      dataLog.warn("extract cache does not match its schema", { callId });
      return null;
    }
    return r.data;
  }

  async getCachedTurns(callId: string): Promise<CachedTurnsFile | null> {
    if (!safeId(callId)) return null;
    const raw = await this.json(`public/data/cached-turns/${callId}.json`);
    if (!raw) return null;
    const r = CachedTurnsFileSchema.safeParse(raw);
    return r.success ? r.data : null;
  }

  async cachedTurnsUrl(callId: string): Promise<string | null> {
    if (!safeId(callId)) return null;
    return existsSync(join(this.root, "public", "data", "cached-turns", `${callId}.json`)) ? `/data/cached-turns/${encodeURIComponent(callId)}.json` : null;
  }
}

const safeId = (id: string): boolean => /^[A-Za-z0-9._-]{1,128}$/.test(id) && !id.includes("..");

/** In-memory source for tests and scripts. */
export class MemoryCaseDataSource implements CaseDataSource {
  constructor(
    private readonly d: {
      calls?: CallManifestEntry[];
      policies?: Record<string, PolicyRecord>;
      extractCaches?: Record<string, ExtractCacheFile>;
      cachedTurns?: Record<string, CachedTurnsFile>;
    } = {},
  ) {}
  async getCall(callId: string) { return this.d.calls?.find((c) => c.callId === callId) ?? null; }
  async featuredCall() { return this.d.calls?.find((c) => c.featured) ?? null; }
  async getPolicy(id: string) { return this.d.policies?.[id] ?? null; }
  async getExtractCache(callId: string) { return this.d.extractCaches?.[callId] ?? null; }
  async getCachedTurns(callId: string) { return this.d.cachedTurns?.[callId] ?? null; }
  async cachedTurnsUrl(callId: string) { return this.d.cachedTurns?.[callId] ? `/data/cached-turns/${encodeURIComponent(callId)}.json` : null; }
}

interface RawWord { text?: unknown; start?: unknown; end?: unknown; confidence?: unknown }
interface RawTurn { type?: unknown; turn_order?: unknown; end_of_turn?: unknown; transcript?: unknown; words?: RawWord[] }

/**
 * The cached finals of a call as `TurnInput`s (G0 ids `${ch}-c${turn_order}`, `source:"stt_cache"`), both channels,
 * in `recvMs` order. The last end-of-turn message of a `turn_order` wins (formatted after unformatted).
 */
export function cachedFinalTurns(file: CachedTurnsFile, caseId: string): TurnInput[] {
  const out: TurnInput[] = [];
  for (const ch of ["rep", "customer"] as const) {
    const byOrder = new Map<number, { recvMs: number; m: RawTurn }>();
    for (const r of file.channels[ch]) {
      const m = r.message as RawTurn;
      if (m.type !== "Turn" || m.end_of_turn !== true || typeof m.turn_order !== "number") continue;
      if (typeof m.transcript !== "string" || !m.transcript.trim()) continue;
      byOrder.set(m.turn_order, { recvMs: r.recvMs, m });
    }
    for (const [order, { recvMs, m }] of byOrder) {
      const words = (m.words ?? [])
        .filter((w) => typeof w.start === "number" && typeof w.end === "number")
        .map((w) => ({ text: String(w.text ?? ""), startMs: w.start as number, endMs: w.end as number, confidence: typeof w.confidence === "number" ? w.confidence : 1 }));
      out.push({
        caseId, turnId: cachedTurnIdOf(ch, order), channel: ch, text: String(m.transcript), words,
        startMs: words[0]?.startMs ?? recvMs, endMs: words.at(-1)?.endMs ?? recvMs, source: "stt_cache", recvMs, cut: false, late: false,
      });
    }
  }
  return out.sort((a, b) => a.recvMs - b.recvMs || a.endMs - b.endMs);
}

// ------------------------------------------------------------------------------------------ process-wide instance

const g = globalThis as typeof globalThis & { __batonCaseData?: CaseDataSource };

export function getCaseDataSource(): CaseDataSource {
  return (g.__batonCaseData ??= new FsCaseDataSource());
}

export function setCaseDataSource(s: CaseDataSource | null): void {
  if (s) g.__batonCaseData = s;
  else delete g.__batonCaseData;
}

/**
 * G1: register the statically imported generated files. Also the lookup WP2's routes #5/#5a use
 * (`registerCallLookup((id) => getCaseDataSource().getCall(id))`).
 */
export function registerGeneratedData(d: { calls?: unknown[]; scenarios?: unknown[] }): void {
  const s = getCaseDataSource();
  if (s instanceof FsCaseDataSource) s.register(d);
}

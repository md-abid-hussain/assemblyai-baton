import "server-only";

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { desc, eq, sql } from "drizzle-orm";

import { decodeWav } from "../../core/audio/wav-decode";
import type { LimitsAuthority } from "../../core/contracts/services";
import { newId } from "../../lib/ids";
import type { Db } from "../db/client";
import { healthChecks } from "../db/schema";
import { env } from "../env";
import type { DbFlagStore } from "../flags";
import { log } from "../log";
import { createOpenAI, MODELS } from "../openai/client";
import { probeFullStt, probeFullVa, probeMintStt, probeMintVa, type ProbeResult } from "../limits/probes";

/**
 * F7 synthetic checks (DESIGN §4.5, §7.7), stored in `health_checks`.
 *
 *  light (hourly, cron): DB read/write; mint an STT token and a VA token (no connect); one 16-token OpenAI `luna`
 *        call; Polar `GET /v1/checkouts?limit=1`; flags readable. ≈ $0.00002.
 *  full (every 6 h, cron): 1 STT session through the broker streaming the health fixture (expects "481529" in a
 *        final) and 1 VA session with a greeting-only config until the first audible chunk, then `session.end`.
 *        ≈ $0.0075. Two consecutive full failures → `replay_only (synthetic_failed)`; the next success restores
 *        `live`, only if that was the reason.
 *
 * The fixture is WP4's `public/fixtures/health_16k.pcm` (raw s16le mono 16 kHz); until it exists the spike's
 * `question_16k.wav` (same order number, 10b) is used when present (local runs only).
 */

export type ProbeMap = Record<string, ProbeResult>;
export interface CheckOutcome {
  kind: "light" | "full";
  ok: boolean;
  details: ProbeMap;
  id: string;
  mode?: { tripped?: boolean; cleared?: boolean };
}

export interface SyntheticDeps {
  db: Db;
  authority: LimitsAuthority;
  /** Present on the authority: mode transitions for synthetic_failed. */
  flags: DbFlagStore | null;
  deployId: string;
  /** Overrides for tests. */
  probes?: Partial<{
    mintStt: () => Promise<ProbeResult>;
    mintVa: () => Promise<ProbeResult>;
    openai: () => Promise<ProbeResult>;
    polar: () => Promise<ProbeResult>;
    fullStt: () => Promise<ProbeResult>;
    fullVa: () => Promise<ProbeResult>;
  }>;
  now?: () => number;
}

const hcLog = log.child({ component: "synthetic" });
const since = (t0: number): number => Math.round(performance.now() - t0);
const fail = (t0: number, code: string, detail?: string): ProbeResult => ({ ok: false, ms: since(t0), code, ...(detail ? { detail: detail.slice(0, 200) } : {}) });

async function timed(fn: () => Promise<ProbeResult>): Promise<ProbeResult> {
  const t0 = performance.now();
  try {
    return await fn();
  } catch (e) {
    return fail(t0, "E_PROBE", e instanceof Error ? e.message : String(e));
  }
}

export async function probeOpenAi(authority: LimitsAuthority, deployId: string): Promise<ProbeResult> {
  const t0 = performance.now();
  const key = env().OPENAI_API_KEY;
  if (!key) return fail(t0, "E_CONFIG", "OPENAI_API_KEY missing");
  const r = await authority.ledger.reserve({ provider: "openai", action: "synthetic_light", refId: `hc-${newId()}`, estUsd: 0.0001, env: deployId });
  if (!r.ok) return fail(t0, "E_BUDGET");
  try {
    const client = createOpenAI(key, { maxRetries: 0, timeoutMs: 15_000 });
    const res = await client.responses.create({ model: MODELS.fast, input: "Reply with the word OK.", max_output_tokens: 16, reasoning: { effort: "none" } } as never);
    const usage = (res as unknown as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
    await authority.ledger.settle(r.id, ((usage?.input_tokens ?? 20) * 0.1 + (usage?.output_tokens ?? 16) * 0.5) / 1e6);
    return { ok: true, ms: since(t0) };
  } catch (e) {
    await authority.ledger.release(r.id).catch(() => undefined);
    return fail(t0, "E_OPENAI", e instanceof Error ? e.message : String(e));
  }
}

export async function probePolar(): Promise<ProbeResult> {
  const t0 = performance.now();
  const e = env();
  if (!e.POLAR_ACCESS_TOKEN) return fail(t0, "E_CONFIG", "POLAR_ACCESS_TOKEN missing");
  const base = e.POLAR_SERVER === "production" ? "https://api.polar.sh" : "https://sandbox-api.polar.sh";
  try {
    const res = await fetch(`${base}/v1/checkouts/?limit=1`, { headers: { Authorization: `Bearer ${e.POLAR_ACCESS_TOKEN}` }, signal: AbortSignal.timeout(10_000) });
    await res.text();
    return res.ok ? { ok: true, ms: since(t0) } : fail(t0, `HTTP_${res.status}`);
  } catch (err) {
    return fail(t0, "E_POLAR_API", err instanceof Error ? err.message : String(err));
  }
}

/** The health fixture as raw s16le 16 kHz mono, or null. */
export function loadHealthFixture(roots: string[] = [process.cwd(), join(process.cwd(), "bundle")]): Uint8Array | null {
  for (const root of roots) {
    const pcm = join(root, "public", "fixtures", "health_16k.pcm");
    if (existsSync(pcm)) return new Uint8Array(readFileSync(pcm));
  }
  for (const root of roots) {
    const wav = join(root, "spikes", "fixtures", "question_16k.wav");
    if (!existsSync(wav)) continue;
    const d = decodeWav(new Uint8Array(readFileSync(wav)));
    if (d.sampleRate !== 16_000 || d.channels !== 1) continue;
    return new Uint8Array(d.samples.buffer, d.samples.byteOffset, d.samples.byteLength);
  }
  return null;
}

async function store(db: Db, kind: "light" | "full", ok: boolean, details: ProbeMap, nowMs: number): Promise<string> {
  const id = newId();
  await db.insert(healthChecks).values({ id, kind, ok, details: details as Record<string, unknown>, createdAt: new Date(nowMs) });
  return id;
}

export async function runLightCheck(d: SyntheticDeps): Promise<CheckOutcome> {
  const nowMs = (d.now ?? Date.now)();
  const details: ProbeMap = {};
  details.db = await timed(async () => {
    const t0 = performance.now();
    const r = await d.db.execute(sql`select 1 as ok`);
    return { ok: (r.rows[0] as { ok?: number } | undefined)?.ok === 1, ms: since(t0) };
  });
  details.flags = await timed(async () => {
    const t0 = performance.now();
    const f = await d.authority.flags();
    return { ok: !!f.mode, ms: since(t0), mode: f.mode };
  });
  details.mintStt = await timed(d.probes?.mintStt ?? probeMintStt);
  details.mintVa = await timed(d.probes?.mintVa ?? probeMintVa);
  details.openai = await timed(d.probes?.openai ?? (() => probeOpenAi(d.authority, d.deployId)));
  details.polar = await timed(d.probes?.polar ?? probePolar);
  const ok = Object.values(details).every((p) => p.ok);
  const id = await store(d.db, "light", ok, details, nowMs);
  // The write above is the DB write probe; read it back.
  const [back] = await d.db.select({ id: healthChecks.id }).from(healthChecks).where(eq(healthChecks.id, id));
  if (!back) details.dbWrite = { ok: false, ms: 0, code: "E_DB" };
  hcLog.info("light check", { ok, failed: Object.entries(details).filter(([, p]) => !p.ok).map(([k]) => k) });
  return { kind: "light", ok: ok && !!back, details, id };
}

export async function runFullCheck(d: SyntheticDeps): Promise<CheckOutcome> {
  const nowMs = (d.now ?? Date.now)();
  const details: ProbeMap = {};
  const e = env();
  const stt: ProbeResult = await (d.probes?.fullStt ??
    (async () => {
      const pcm = loadHealthFixture();
      if (!pcm) return { ok: false, ms: 0, code: "E_FIXTURE_MISSING", detail: "public/fixtures/health_16k.pcm not found" };
      return probeFullStt(d.authority, { pcm16k: pcm, expectDigits: "481529", deployId: d.deployId });
    }))();
  const va: ProbeResult = await (d.probes?.fullVa ?? (() => probeFullVa(d.authority, { deployId: d.deployId, voice: e.VA_VOICE })))();
  details.stt = stt;
  details.va = va;
  const ok = stt.ok && va.ok;
  const id = await store(d.db, "full", ok, details, nowMs);

  const mode: CheckOutcome["mode"] = {};
  if (d.flags) {
    if (ok) mode.cleared = await d.flags.clearIf("synthetic_failed");
    else {
      const last2 = await d.db.select({ ok: healthChecks.ok }).from(healthChecks).where(eq(healthChecks.kind, "full")).orderBy(desc(healthChecks.createdAt)).limit(2);
      if (last2.length === 2 && last2.every((r) => !r.ok)) mode.tripped = await d.flags.tripReplayOnly("synthetic_failed");
    }
  }
  hcLog[ok ? "info" : "warn"]("full check", { ok, stt: stt.code ?? "ok", va: va.code ?? "ok", ...mode });
  return { kind: "full", ok, details, id, mode };
}

/** Latest light and full checks for /api/status. */
export async function lastChecks(db: Db, nowMs = Date.now()): Promise<{ light: { ok: boolean; at: string; ageSec: number } | null; full: { ok: boolean; at: string; ageSec: number } | null }> {
  const one = async (kind: "light" | "full") => {
    const [r] = await db
      .select({ ok: healthChecks.ok, at: healthChecks.createdAt })
      .from(healthChecks)
      .where(eq(healthChecks.kind, kind))
      .orderBy(desc(healthChecks.createdAt))
      .limit(1);
    return r ? { ok: r.ok, at: r.at.toISOString(), ageSec: Math.max(0, Math.round((nowMs - r.at.getTime()) / 1000)) } : null;
  };
  return { light: await one("light"), full: await one("full") };
}

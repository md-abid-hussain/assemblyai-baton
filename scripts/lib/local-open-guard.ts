/**
 * local-open-guard.ts - the file-lock `LimitsAuthority` for THIS laptop (DESIGN §2.3, TASKS §0.5).
 *
 * Before the Zerops authority exists (T-D1-8), every agent, script and live test on the user's laptop opens
 * AssemblyAI sessions only through this guard. It enforces, across processes and git worktrees:
 *   - at most `STT_OPENS_PER_MIN` (default 4; free tier is 5, 1 spare) new streaming sessions per rolling 60 s;
 *   - at most `LOCAL_GUARD_VA_MAX` (default 1) Voice Agent session (held or open) at a time;
 *   - a local daily AssemblyAI spend cap `LOCAL_GUARD_DAILY_CAP_USD` (default 5) on ledger reservations;
 *   - a local kill switch (`mode`), set with the CLI below.
 *
 * State lives in ONE machine-wide directory (default `~/.baton/limits`, override `LOCAL_GUARD_DIR`), so every
 * worktree shares it. Each operation takes an exclusive lock file (`O_CREAT|O_EXCL`), reads `state.json`,
 * mutates it and writes it back atomically (temp + rename). Critical sections are a few ms; a lock older than
 * `LOCK_STALE_MS` is considered abandoned (crashed process) and broken.
 *
 * VA sessions whose owning process died (`process.kill(pid, 0)` fails), whose heartbeat is older than 30 s, or
 * that ran past `capMs + 60 s` are marked stale and free their slot (mirrors F5).
 *
 * CLI: `npx tsx scripts/lib/local-open-guard.ts status|reset|replay-only|live`
 */
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { AppFlags, LimitsAuthority, OpenSource, SlotResult, SpendLedger } from "../../src/core/contracts/services";
import type { SessionReport } from "../../src/core/contracts/api";

// ---------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------

export const WINDOW_MS = 60_000;
export const LOCK_STALE_MS = 5_000;
export const LOCK_TIMEOUT_MS = 10_000;
export const TICKET_TTL_MS = 10_000;
export const HEARTBEAT_STALE_MS = 30_000;

export interface LocalGuardOptions {
  /** Directory holding `state.json` and the lock (default `LOCAL_GUARD_DIR` or `~/.baton/limits`). */
  dir?: string;
  sttOpensPerMin?: number;
  sttQueueMaxWaitMs?: number;
  vaMax?: number;
  dailyCapUsd?: number;
  /** Injected clock (tests). */
  now?: () => number;
  /** Injected liveness check (tests). Default: `process.kill(pid, 0)`. */
  isPidAlive?: (pid: number) => boolean;
}

function numEnv(name: string, def: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : def;
}

export function defaultGuardDir(): string {
  // turbopackIgnore: src/server/limits imports this module; a dynamic path would make Next trace the whole project.
  return resolve(/*turbopackIgnore: true*/ process.env.LOCAL_GUARD_DIR || join(homedir(), ".baton", "limits"));
}

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

interface SttOpen {
  grantId: string;
  at: number;
  n: number;
  source: OpenSource;
  deployId: string;
  pid: number;
}
interface SttTicket {
  ticket: string;
  n: number;
  createdAt: number;
  lastPollAt: number;
  pid: number;
}
interface VaEntry {
  id: string;
  status: "held" | "open";
  pid: number;
  createdAt: number;
  /** Hold expiry (held) or cap deadline (open), epoch ms. */
  expiresAt: number;
  capMs: number;
  lastHeartbeatAt: number;
  deployId: string;
  source: OpenSource | "run";
  runId?: string;
  takeoverId?: string;
}
interface LedgerEntry {
  id: string;
  day: string;
  at: number;
  provider: "aai_stt" | "aai_va" | "aai_async" | "openai" | "polar";
  action: string;
  refId: string;
  env: string;
  estUsd: number;
  actualUsd: number | null;
  status: "reserved" | "settled" | "released";
}
interface ReportEntry extends SessionReport {
  at: number;
  pid: number;
}
interface GuardEvent {
  at: number;
  kind: string;
  id: string;
  detail?: string;
}
export interface GuardState {
  version: 1;
  flags: AppFlags;
  sttOpens: SttOpen[];
  sttQueue: SttTicket[];
  va: VaEntry[];
  ledger: LedgerEntry[];
  reports: ReportEntry[];
  events: GuardEvent[];
}

const DEFAULT_FLAGS: AppFlags = { mode: "live", reason: null, notice: null, paymentsModeOverride: null, aaiBalanceUsd: null };

function emptyState(): GuardState {
  return { version: 1, flags: { ...DEFAULT_FLAGS }, sttOpens: [], sttQueue: [], va: [], ledger: [], reports: [], events: [] };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function defaultIsPidAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: exists but not ours to signal -> alive.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

// ---------------------------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------------------------

export class LocalOpenGuard implements LimitsAuthority {
  readonly dir: string;
  readonly statePath: string;
  readonly lockPath: string;
  readonly sttOpensPerMin: number;
  readonly sttQueueMaxWaitMs: number;
  readonly vaMax: number;
  readonly dailyCapUsd: number;
  private readonly now: () => number;
  private readonly isPidAlive: (pid: number) => boolean;
  readonly ledger: SpendLedger;

  constructor(opts: LocalGuardOptions = {}) {
    this.dir = resolve(/*turbopackIgnore: true*/ opts.dir ?? defaultGuardDir());
    this.statePath = join(this.dir, "state.json");
    this.lockPath = join(this.dir, "state.lock");
    this.sttOpensPerMin = opts.sttOpensPerMin ?? Math.min(numEnv("STT_OPENS_PER_MIN", 4), 5);
    this.sttQueueMaxWaitMs = opts.sttQueueMaxWaitMs ?? numEnv("STT_QUEUE_MAX_WAIT_S", 15) * 1000;
    this.vaMax = opts.vaMax ?? numEnv("LOCAL_GUARD_VA_MAX", 1);
    this.dailyCapUsd = opts.dailyCapUsd ?? numEnv("LOCAL_GUARD_DAILY_CAP_USD", 5);
    this.now = opts.now ?? Date.now;
    this.isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
    mkdirSync(this.dir, { recursive: true });
    this.ledger = this.makeLedger();
  }

  // ---- locking ------------------------------------------------------------------------------

  private async lock(): Promise<() => void> {
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (let attempt = 0; ; attempt++) {
      try {
        const fd = openSync(this.lockPath, "wx");
        try {
          writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
        } finally {
          closeSync(fd);
        }
        return () => {
          try {
            unlinkSync(this.lockPath);
          } catch {
            /* already broken by someone else */
          }
        };
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== "EEXIST" && code !== "EPERM" && code !== "EBUSY") throw e;
        try {
          const age = Date.now() - statSync(this.lockPath).mtimeMs;
          if (age > LOCK_STALE_MS) unlinkSync(this.lockPath);
        } catch {
          /* raced: the lock was released or re-created */
        }
        if (Date.now() > deadline) throw new Error(`[local-open-guard] could not take the lock ${this.lockPath} within ${LOCK_TIMEOUT_MS} ms`);
        await sleep(5 + Math.floor(Math.random() * Math.min(50, 5 * (attempt + 1))));
      }
    }
  }

  private read(): GuardState {
    if (!existsSync(this.statePath)) return emptyState();
    try {
      const s = JSON.parse(readFileSync(this.statePath, "utf8")) as Partial<GuardState>;
      const base = emptyState();
      return { ...base, ...s, flags: { ...base.flags, ...(s.flags ?? {}) } } as GuardState;
    } catch {
      // A corrupt file must never block (or silently widen) the guard: start clean but keep the evidence.
      try {
        renameSync(this.statePath, `${this.statePath}.corrupt-${Date.now()}`);
      } catch {
        /* ignore */
      }
      return emptyState();
    }
  }

  private write(s: GuardState): void {
    const tmp = `${this.statePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    writeFileSync(tmp, JSON.stringify(s, null, 1));
    renameSync(tmp, this.statePath);
  }

  /** Run `fn` on the state under the lock; persists when `fn` returns. */
  private async tx<T>(fn: (s: GuardState, now: number) => T): Promise<T> {
    const unlock = await this.lock();
    try {
      const s = this.read();
      const now = this.now();
      this.prune(s, now);
      const out = fn(s, now);
      this.write(s);
      return out;
    } finally {
      unlock();
    }
  }

  private event(s: GuardState, now: number, kind: string, id: string, detail?: string): void {
    s.events.push({ at: now, kind, id, ...(detail ? { detail } : {}) });
    if (s.events.length > 300) s.events.splice(0, s.events.length - 300);
  }

  private prune(s: GuardState, now: number): void {
    s.sttOpens = s.sttOpens.filter((o) => now - o.at < WINDOW_MS);
    s.sttQueue = s.sttQueue.filter((t) => now - t.lastPollAt < TICKET_TTL_MS);
    const keep: VaEntry[] = [];
    for (const v of s.va) {
      let stale: string | null = null;
      if (v.status === "held" && now > v.expiresAt) stale = "hold expired";
      else if (v.status === "open" && now > v.expiresAt + 60_000) stale = "past cap + 60 s";
      else if (v.status === "open" && now - v.lastHeartbeatAt > HEARTBEAT_STALE_MS) stale = "no heartbeat for 30 s";
      else if (!this.isPidAlive(v.pid)) stale = `owner pid ${v.pid} is gone`;
      if (stale) this.event(s, now, "va.stale", v.id, stale);
      else keep.push(v);
    }
    s.va = keep;
    const weekAgo = utcDay(now - 7 * 86_400_000);
    s.ledger = s.ledger.filter((e) => e.day >= weekAgo);
    if (s.reports.length > 500) s.reports.splice(0, s.reports.length - 500);
  }

  // ---- STT ---------------------------------------------------------------------------------

  private used(s: GuardState, at: number): number {
    return s.sttOpens.reduce((sum, o) => (at - o.at < WINDOW_MS ? sum + o.n : sum), 0);
  }

  /** ms until `need` more slots fit in the rolling window, or null if they never can. */
  private etaMs(s: GuardState, now: number, need: number): number | null {
    if (need > this.sttOpensPerMin) return null;
    const candidates = [now, ...s.sttOpens.map((o) => o.at + WINDOW_MS).filter((t) => t > now)].sort((a, b) => a - b);
    for (const t of candidates) if (this.used(s, t) + need <= this.sttOpensPerMin) return t - now;
    return null;
  }

  async sttAcquire(req: Parameters<LimitsAuthority["sttAcquire"]>[0]): Promise<SlotResult> {
    return this.tx((s, now): SlotResult => {
      if (s.flags.mode !== "live") {
        return { status: "denied", code: "E_MODE_REPLAY_ONLY", message: `local guard mode is ${s.flags.mode}${s.flags.reason ? ` (${s.flags.reason})` : ""}` };
      }
      let idx = req.ticket ? s.sttQueue.findIndex((t) => t.ticket === req.ticket) : -1;
      if (idx >= 0) s.sttQueue[idx]!.lastPollAt = now;
      const ahead = idx >= 0 ? s.sttQueue.slice(0, idx) : s.sttQueue;
      const aheadN = ahead.reduce((a, t) => a + t.n, 0);
      const fits = this.used(s, now) + req.n <= this.sttOpensPerMin;

      if (fits && ahead.length === 0) {
        if (idx >= 0) s.sttQueue.splice(idx, 1);
        const grantId = `lg_stt_${randomUUID()}`;
        // One live-session id per granted open ([rep, customer] for n = 2), used by the opener's reports (G0).
        const sessionIds = Array.from({ length: req.n }, () => `lg_ss_${randomUUID()}`);
        s.sttOpens.push({ grantId, at: now, n: req.n, source: req.source, deployId: req.deployId, pid: process.pid });
        this.event(s, now, "stt.granted", grantId, `n=${req.n} source=${req.source} sessions=${sessionIds.join(",")}`);
        return { status: "granted", grantId, sessionIds };
      }

      const eta = this.etaMs(s, now, aheadN + req.n);
      if (eta === null || eta > this.sttQueueMaxWaitMs) {
        if (idx >= 0) s.sttQueue.splice(idx, 1);
        return {
          status: "denied",
          code: "E_QUEUE_TIMEOUT",
          message: `no streaming slot within ${Math.round(this.sttQueueMaxWaitMs / 1000)} s (limit ${this.sttOpensPerMin}/60 s on this laptop)`,
        };
      }
      if (idx < 0) {
        const ticket = `lg_tkt_${randomUUID()}`;
        s.sttQueue.push({ ticket, n: req.n, createdAt: now, lastPollAt: now, pid: process.pid });
        idx = s.sttQueue.length - 1;
        return { status: "queued", ticket, position: idx, etaMs: Math.max(eta, 250) };
      }
      return { status: "queued", ticket: req.ticket!, position: idx, etaMs: Math.max(eta, 250) };
    });
  }

  async sttCancel(ticket: string): Promise<void> {
    await this.tx((s) => {
      s.sttQueue = s.sttQueue.filter((t) => t.ticket !== ticket);
    });
  }

  // ---- Voice Agent -------------------------------------------------------------------------

  private vaActive(s: GuardState): number {
    return s.va.length;
  }

  async vaHold(req: Parameters<LimitsAuthority["vaHold"]>[0]): ReturnType<LimitsAuthority["vaHold"]> {
    return this.tx((s, now) => {
      if (s.flags.mode !== "live") return { ok: false as const, code: "E_MODE_REPLAY_ONLY" as const, message: `local guard mode is ${s.flags.mode}` };
      if (this.vaActive(s) >= this.vaMax) {
        return { ok: false as const, code: "E_VA_CAPACITY" as const, message: `local guard: ${this.vaMax} Voice Agent session(s) already held or open` };
      }
      const expiresAt = Date.parse(req.expiresAt);
      const holdId = `lg_hold_${randomUUID()}`;
      s.va.push({
        id: holdId,
        status: "held",
        pid: process.pid,
        createdAt: now,
        expiresAt: Number.isFinite(expiresAt) ? expiresAt : now + 10 * 60_000,
        capMs: 0,
        lastHeartbeatAt: now,
        deployId: req.deployId,
        source: "run",
        runId: req.runId,
      });
      this.event(s, now, "va.held", holdId);
      return { ok: true as const, holdId };
    });
  }

  async vaAcquire(req: Parameters<LimitsAuthority["vaAcquire"]>[0]): ReturnType<LimitsAuthority["vaAcquire"]> {
    return this.tx((s, now) => {
      if (s.flags.mode !== "live") return { ok: false as const, code: "E_MODE_REPLAY_ONLY" as const, message: `local guard mode is ${s.flags.mode}` };
      const hold = req.holdId ? s.va.find((v) => v.id === req.holdId && v.status === "held") : undefined;
      if (!hold && this.vaActive(s) >= this.vaMax) {
        const owners = s.va.map((v) => `${v.status} by pid ${v.pid} (${v.deployId})`).join(", ");
        return { ok: false as const, code: "E_VA_CAPACITY" as const, message: `local guard: Voice Agent slot busy: ${owners}` };
      }
      const liveSessionId = `lg_va_${randomUUID()}`;
      if (hold) s.va = s.va.filter((v) => v !== hold);
      s.va.push({
        id: liveSessionId,
        status: "open",
        pid: process.pid,
        createdAt: now,
        expiresAt: now + req.capMs,
        capMs: req.capMs,
        lastHeartbeatAt: now,
        deployId: req.deployId,
        source: req.source,
        ...(req.takeoverId ? { takeoverId: req.takeoverId } : {}),
      });
      this.event(s, now, "va.open", liveSessionId, `attempt=${req.attempt} cap=${req.capMs}ms`);
      return { ok: true as const, liveSessionId };
    });
  }

  async release(liveSessionIdOrHoldId: string, reason: string): Promise<void> {
    await this.tx((s, now) => {
      const before = s.va.length;
      s.va = s.va.filter((v) => v.id !== liveSessionIdOrHoldId);
      if (s.va.length !== before) this.event(s, now, "va.released", liveSessionIdOrHoldId, reason);
    });
  }

  async heartbeat(liveSessionId: string): Promise<void> {
    await this.tx((s, now) => {
      const v = s.va.find((x) => x.id === liveSessionId);
      if (v) v.lastHeartbeatAt = now;
    });
  }

  async report(r: SessionReport): Promise<void> {
    await this.tx((s, now) => {
      s.reports.push({ ...r, at: now, pid: process.pid });
      if (r.kind === "va" && r.event === "closed") s.va = s.va.filter((v) => v.id !== r.sessionId);
    });
  }

  async flags(): Promise<AppFlags> {
    return this.tx((s) => ({ ...s.flags }));
  }

  /** Operator kill switch for this laptop (CLI `replay-only` / `live`). */
  async setMode(mode: AppFlags["mode"], reason: string | null): Promise<void> {
    await this.tx((s, now) => {
      s.flags = { ...s.flags, mode, reason };
      this.event(s, now, "flags.mode", mode, reason ?? undefined);
    });
  }

  /** Read-only snapshot (after pruning) for status output and tests. */
  async snapshot(): Promise<GuardState> {
    return this.tx((s) => structuredClone(s));
  }

  /** Drop all state (CLI `reset`). */
  async reset(): Promise<void> {
    const unlock = await this.lock();
    try {
      this.write(emptyState());
    } finally {
      unlock();
    }
  }

  // ---- ledger ------------------------------------------------------------------------------

  private makeLedger(): SpendLedger {
    const aaiToday = (s: GuardState, day: string) =>
      s.ledger
        .filter((e) => e.day === day && e.provider.startsWith("aai") && e.status !== "released")
        .reduce((a, e) => a + (e.actualUsd ?? e.estUsd), 0);
    return {
      reserve: (e) =>
        this.tx((s, now) => {
          const day = utcDay(now);
          if (e.provider.startsWith("aai") && aaiToday(s, day) + e.estUsd > this.dailyCapUsd) {
            this.event(s, now, "ledger.denied", e.refId, `${e.provider} ${e.estUsd}`);
            return { ok: false as const, code: "E_BUDGET" as const };
          }
          const id = `lg_led_${randomUUID()}`;
          s.ledger.push({ id, day, at: now, ...e, actualUsd: null, status: "reserved" });
          return { ok: true as const, id };
        }),
      settle: (id, actualUsd) =>
        this.tx((s) => {
          const e = s.ledger.find((x) => x.id === id);
          if (e) {
            e.actualUsd = actualUsd;
            e.status = "settled";
          }
        }),
      release: (id) =>
        this.tx((s) => {
          const e = s.ledger.find((x) => x.id === id);
          if (e && e.status === "reserved") e.status = "released";
        }),
      summary: () =>
        this.tx((s, now) => {
          const day = utcDay(now);
          const epoch = process.env.LEDGER_EPOCH ? Date.parse(process.env.LEDGER_EPOCH) : Number.NaN;
          const live = s.ledger.filter((e) => e.status !== "released");
          const cost = (e: LedgerEntry) => e.actualUsd ?? e.estUsd;
          const todayUsd: Record<string, number> = {};
          const byEnv: Record<string, number> = {};
          for (const e of live) {
            if (e.day === day) todayUsd[e.provider] = (todayUsd[e.provider] ?? 0) + cost(e);
            byEnv[e.env] = (byEnv[e.env] ?? 0) + cost(e);
          }
          const aai = aaiToday(s, day);
          return {
            sinceEpochUsd: Number.isFinite(epoch) ? live.filter((e) => e.at >= epoch).reduce((a, e) => a + cost(e), 0) : 0,
            todayUsd,
            dailyCapUsd: this.dailyCapUsd,
            judgingBudgetUsd: numEnv("AAI_JUDGING_BUDGET_USD", 0),
            pctToday: this.dailyCapUsd > 0 ? Math.round((aai / this.dailyCapUsd) * 1000) / 10 : 0,
            byEnv,
          };
        }),
    };
  }
}

let shared: LocalOpenGuard | null = null;
/** The process-wide guard over the machine-wide state directory. */
export function getLocalOpenGuard(): LocalOpenGuard {
  shared ??= new LocalOpenGuard();
  return shared;
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

async function main(argv: string[]): Promise<number> {
  const guard = new LocalOpenGuard();
  const cmd = argv[0] ?? "status";
  if (cmd === "reset") {
    await guard.reset();
    console.log(`[local-open-guard] state reset (${guard.statePath})`);
  } else if (cmd === "replay-only" || cmd === "kill") {
    await guard.setMode("replay_only", argv[1] ?? "operator");
    console.log("[local-open-guard] mode = replay_only: new opens are refused on this laptop");
  } else if (cmd === "live") {
    await guard.setMode("live", null);
    console.log("[local-open-guard] mode = live");
  } else if (cmd === "status") {
    const s = await guard.snapshot();
    const now = Date.now();
    const used = s.sttOpens.reduce((a, o) => a + o.n, 0);
    console.log(
      JSON.stringify(
        {
          dir: guard.dir,
          mode: s.flags.mode,
          stt: { usedInWindow: used, limitPer60s: guard.sttOpensPerMin, queued: s.sttQueue.length },
          va: { active: s.va.map((v) => ({ id: v.id, status: v.status, pid: v.pid, deployId: v.deployId, ageS: Math.round((now - v.createdAt) / 1000) })), max: guard.vaMax },
          ledger: await guard.ledger.summary(),
          recentEvents: s.events.slice(-10),
        },
        null,
        2,
      ),
    );
  } else {
    console.error("usage: tsx scripts/lib/local-open-guard.ts status|reset|replay-only [reason]|live");
    return 2;
  }
  return 0;
}

const invokedDirectly = process.argv[1] ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href : false;
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(`[local-open-guard] ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    },
  );
}

import "server-only";

/**
 * Connector call limits (PLATFORM §6.2 "Limits"): ≤ 10 calls per run per connector, ≤ 60 per hour per workspace,
 * ≤ 20 per minute per destination host, and globally ≤ 300 per hour and ≤ 2000 per day (the real guard, since
 * workspaces are cheap to mint).
 *
 * In-process sliding windows: the app runs as ONE Zerops container (DESIGN §2.3), so process memory is the whole
 * truth for these short windows; a restart forgets them, which only loosens the limit for a moment. Memory is bounded
 * because the global day window (2000) bounds every other window's entries.
 */

export const CONNECTOR_LIMITS = {
  perRunPerConnector: 10,
  perWorkspacePerHour: 60,
  perHostPerMinute: 20,
  globalPerHour: 300,
  globalPerDay: 2000,
} as const;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** A run can't outlive this; its per-connector counter is dropped after it. */
const RUN_WINDOW = 2 * HOUR;

export interface ConnectorCallKey {
  /** The takeover id, or `console:<visitor>` for test-console calls. Null = no per-run limit. */
  runKey: string | null;
  connectorId: string;
  workspaceId: string;
  /** The destination host for http_action / webhooks; null for built-in connectors. */
  host: string | null;
}

export type LimitVerdict =
  | { ok: true }
  | { ok: false; limit: keyof typeof CONNECTOR_LIMITS; retryAfterMs: number };

export class ConnectorRateLimiter {
  private readonly windows = new Map<string, number[]>();
  constructor(private readonly limits: Record<keyof typeof CONNECTOR_LIMITS, number> = CONNECTOR_LIMITS) {}

  private buckets(k: ConnectorCallKey): { key: string; limit: keyof typeof CONNECTOR_LIMITS; windowMs: number }[] {
    const out: { key: string; limit: keyof typeof CONNECTOR_LIMITS; windowMs: number }[] = [
      { key: "g:h", limit: "globalPerHour", windowMs: HOUR },
      { key: "g:d", limit: "globalPerDay", windowMs: DAY },
      { key: `w:${k.workspaceId}`, limit: "perWorkspacePerHour", windowMs: HOUR },
    ];
    if (k.host) out.push({ key: `h:${k.host.toLowerCase()}`, limit: "perHostPerMinute", windowMs: MIN });
    if (k.runKey) out.push({ key: `r:${k.runKey}:${k.connectorId}`, limit: "perRunPerConnector", windowMs: RUN_WINDOW });
    return out;
  }

  private live(key: string, windowMs: number, now: number): number[] {
    const arr = this.windows.get(key);
    if (!arr) return [];
    let drop = 0;
    while (drop < arr.length && arr[drop]! <= now - windowMs) drop++;
    if (drop) arr.splice(0, drop);
    if (arr.length === 0) this.windows.delete(key);
    return arr;
  }

  /** Check every window and, when all pass, count the call. */
  take(k: ConnectorCallKey, now = Date.now()): LimitVerdict {
    const buckets = this.buckets(k);
    for (const b of buckets) {
      const arr = this.live(b.key, b.windowMs, now);
      if (arr.length >= this.limits[b.limit]) return { ok: false, limit: b.limit, retryAfterMs: Math.max(1000, arr[0]! + b.windowMs - now) };
    }
    for (const b of buckets) {
      const arr = this.windows.get(b.key);
      if (arr) arr.push(now);
      else this.windows.set(b.key, [now]);
    }
    this.sweep(now);
    return { ok: true };
  }

  private lastSweep = 0;
  /** Drop dead per-workspace/host/run keys now and then, so idle keys don't pile up. */
  private sweep(now: number): void {
    if (now - this.lastSweep < MIN) return;
    this.lastSweep = now;
    for (const key of [...this.windows.keys()]) {
      const windowMs = key.startsWith("h:") ? MIN : key.startsWith("r:") ? RUN_WINDOW : key === "g:d" ? DAY : HOUR;
      this.live(key, windowMs, now);
    }
  }

  reset(): void {
    this.windows.clear();
  }
}

/** The process-wide limiter. */
export const connectorLimiter = new ConnectorRateLimiter();

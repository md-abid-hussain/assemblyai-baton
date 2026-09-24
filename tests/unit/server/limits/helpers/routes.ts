/**
 * Route-level test harness: points the app's `getDb()`/`env()` at a throwaway test database, injects a DB authority
 * (optionally with a fake clock) and a fake token minter (no network), and builds authenticated requests.
 * Secrets here are fixed test values, never the real `.env` ones.
 */
import { sql } from "drizzle-orm";

import type { PolicyRecord } from "@/core/contracts/case";
import type { RunPlan } from "@/core/contracts/run";
import { setTokenMinter, setBalanceErrorHandler, type TokenMinter } from "@/server/aai/tokens";
import { issueCaseToken } from "@/server/auth/case-token";
import { signVisitorId } from "@/server/auth/visitor";
import { closeDb } from "@/server/db/client";
import { cases, takeovers } from "@/server/db/schema";
import { resetEnvCache } from "@/server/env";
import { DbFlagStore } from "@/server/flags";
import { defaultLimitsConfig, type LimitsConfig } from "@/server/limits/config";
import { DbLimitsAuthority } from "@/server/limits/db-authority";
import { resetLimitsCache, setLimitsAuthority, setRateLimiter } from "@/server/limits/index";
import type { TestDb } from "./test-db";

export const TEST_SECRETS = {
  CASE_TOKEN_SECRET: "test-case-token-secret-0123456789abcdef",
  VISITOR_SECRET: "test-visitor-secret-0123456789abcdef",
  ADMIN_KEY: "test-admin-key-0123456789",
  CRON_SECRET: "test-cron-secret-0123456789",
  LIMITS_AUTHORITY_KEY: "test-limits-key-0123456789",
} as const;

const TOUCHED = [
  "DATABASE_URL", "LIMITS_ROLE", "LIMITS_AUTHORITY_URL", "BATON_DEPLOY_ID", "ENABLE_INPROC_WORKER", "ASSEMBLYAI_API_KEY",
  "OPENAI_API_KEY", "POLAR_ACCESS_TOKEN", "LEDGER_EPOCH", ...Object.keys(TEST_SECRETS),
];

export interface RouteEnv {
  authority: DbLimitsAuthority;
  flags: DbFlagStore;
  restore(): Promise<void>;
}

export async function setupRouteEnv(
  t: TestDb,
  o: { now?: () => number; config?: LimitsConfig; env?: Record<string, string>; minter?: TokenMinter } = {},
): Promise<RouteEnv> {
  const saved = new Map(TOUCHED.map((k) => [k, process.env[k]]));
  for (const k of TOUCHED) delete process.env[k];
  Object.assign(process.env, TEST_SECRETS, { DATABASE_URL: t.url, LIMITS_ROLE: "authority", BATON_DEPLOY_ID: "dev-test" }, o.env ?? {});
  resetEnvCache();
  await closeDb();
  resetLimitsCache();
  const flags = new DbFlagStore(t.db, o.now ?? Date.now);
  const authority = new DbLimitsAuthority({ db: t.db, config: o.config ?? defaultLimitsConfig(), ...(o.now ? { now: o.now } : {}), flags });
  setLimitsAuthority(authority);
  setRateLimiter(null);
  setTokenMinter(o.minter ?? fakeMinter());
  setBalanceErrorHandler(async () => {
    await flags.tripReplayOnly("aai_balance");
  });
  return {
    authority,
    flags,
    async restore() {
      setLimitsAuthority(null);
      setTokenMinter(null);
      setBalanceErrorHandler(null);
      await closeDb();
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      resetEnvCache();
      resetLimitsCache();
    },
  };
}

export function fakeMinter(over: Partial<TokenMinter> = {}): TokenMinter & { calls: { stt: number; va: number } } {
  const calls = { stt: 0, va: 0 };
  return {
    calls,
    stt: over.stt ?? (async (o) => (calls.stt++, { token: `fake-stt-token-${calls.stt}-xxxxxxxxxxxxxxxx`, expiresInSeconds: o.expiresInSeconds })),
    va: over.va ?? (async (o) => (calls.va++, { token: `fake-va-token-${calls.va}-xxxxxxxxxxxxxxxxx`, expiresInSeconds: o.expiresInSeconds })),
  };
}

export async function truncateAll(t: TestDb): Promise<void> {
  await t.db.execute(sql`truncate cases, live_sessions, stream_queue, spend_ledger, rate_events, jobs, health_checks cascade`);
  await t.db.execute(sql`update app_flags set value = case key when 'mode' then '"live"'::jsonb else 'null'::jsonb end, reason = 'test'`);
}

export const POLICY: PolicyRecord = {
  policyNumber: "HV-100200",
  carrier: "Northwind Mutual",
  agencyName: "Harborview Insurance Agency",
  repFirstName: "Daniel",
  policyholder: { firstName: "Maya", lastName: "Chen" },
  phoneOnFileLast4: "0200",
  address: { street: "12 Elm St", city: "Springfield", state: "IL", zip: "62701" },
  existingDrivers: [{ name: "Maya Chen", relation: "self" }],
  vehicles: [{ id: "v1", year: 2021, make: "Toyota", model: "Highlander", label: "2021 Toyota Highlander" }],
  currentMonthlyPremiumUsd: 142,
  callDate: "2026-09-25",
};

export async function insertCase(
  t: TestDb,
  c: { id: string; visitorId: string; status?: "shadowing" | "armed" | "ai_active" | "completed"; runPlan?: RunPlan | null; callId?: string | null },
): Promise<void> {
  await t.db.insert(cases).values({
    id: c.id,
    mode: "watch",
    callId: c.callId ?? "s01_take1",
    scenarioId: "s01",
    policy: POLICY as unknown as Record<string, unknown>,
    state: { caseId: c.id } as Record<string, unknown>,
    status: c.status ?? "shadowing",
    visitorId: c.visitorId,
    ipKey: "ipk",
    runPlan: (c.runPlan ?? null) as unknown as Record<string, unknown> | null,
  });
}

export async function insertTakeover(
  t: TestDb,
  k: { id: string; caseId: string; armedAt?: Date; retries?: number; lastFailureAt?: Date | null; endedAt?: Date | null },
): Promise<void> {
  await t.db.insert(takeovers).values({
    id: k.id,
    caseId: k.caseId,
    armedAt: k.armedAt ?? new Date(),
    tArmMs: 42_000.5,
    retries: k.retries ?? 0,
    lastFailureAt: k.lastFailureAt ?? null,
    endedAt: k.endedAt ?? null,
  });
}

/** Headers of a browser with a visitor cookie (or only the x-baton-visitor header when `cookieless`). */
export function visitorHeaders(visitorId: string, o: { ip?: string; cookieless?: boolean } = {}): Record<string, string> {
  const signed = signVisitorId(visitorId, TEST_SECRETS.VISITOR_SECRET);
  return {
    "x-forwarded-for": `${o.ip ?? "203.0.113.7"}, 10.0.0.1`,
    ...(o.cookieless ? { "x-baton-visitor": signed } : { cookie: `other=1; bvid=${encodeURIComponent(signed)}` }),
  };
}

export async function caseAuthHeaders(
  caseId: string,
  visitorId: string,
  o: { takeoverId?: string; ip?: string; cookieless?: boolean; ttlSec?: number; now?: number } = {},
): Promise<Record<string, string>> {
  const token = await issueCaseToken({
    caseId,
    visitorId,
    secret: TEST_SECRETS.CASE_TOKEN_SECRET,
    ...(o.takeoverId ? { takeoverId: o.takeoverId } : {}),
    ...(o.ttlSec !== undefined ? { ttlSec: o.ttlSec } : {}),
    ...(o.now !== undefined ? { now: o.now } : {}),
  });
  return { ...visitorHeaders(visitorId, o), authorization: `Bearer ${token}`, "content-type": "application/json" };
}

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

/** Call a route handler in-process. */
export async function call(
  h: Handler,
  o: { method?: string; path?: string; headers?: Record<string, string>; body?: unknown; params?: Record<string, string> } = {},
): Promise<{ status: number; body: any; headers: Headers }> {
  const req = new Request(`http://localhost${o.path ?? "/"}`, {
    method: o.method ?? "POST",
    headers: o.headers ?? {},
    ...(o.body !== undefined ? { body: typeof o.body === "string" ? o.body : JSON.stringify(o.body) } : {}),
  });
  const res = await h(req, { params: Promise.resolve(o.params ?? {}) });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep text */
  }
  return { status: res.status, body, headers: res.headers };
}

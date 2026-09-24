import "server-only";

import { jwtVerify } from "jose";

import { BatonError } from "../../core/contracts/errors";
import type { CaseRepository, RateLimiter } from "../../core/contracts/services";
import { getDb } from "../db/client";
import { env } from "../env";
import { log } from "../log";
import { PaymentService, type PaymentsMode } from "../payments/service";
import { DbPaymentStore } from "../payments/store";
import { sdkPolarApi } from "../polar/client";
import { kitRatingSource, type RatingSource } from "../rating";
import { getToolCore, setToolCore, type ToolCore } from "./core-port";
import { Wp6ToolService } from "./service";
import { DbToolStore, type ToolStore } from "./store";

/**
 * WP6 composition root: the routes (#14–#18) call `wp6()`. Everything another WP provides is injected with
 * `configureWp6({...})` by the integrator at G1 (see docs/notes/wp6.md "Integrator wiring"):
 * - `cases`: WP3's `CaseRepository` (`load`, `applyEvents`); the tool routes need it (payments do not);
 * - `requireTakeover`: WP2's `requireCase(req, {takeoverId, scope})` (the default below verifies the case JWT of
 *   DESIGN §4.3 itself, without the visitor-cookie match);
 * - `rateLimiter`: WP2's `getRateLimiter()` (default: an in-process fixed-window limiter);
 * - `paymentsModeOverride`: WP2's flags (`app_flags.payments_mode_override`);
 * - `core`: WP1's functions (or `setToolCore`); `rating`: WP9's normalized scenarios.
 */

export interface TakeoverAuth {
  caseId: string;
  visitorId: string;
  takeoverId: string | null;
}
export type RequireTakeover = (req: Request, want: { takeoverId: string; scope: "tools" | "case" }) => Promise<TakeoverAuth>;

export interface Wp6Config {
  cases?: Pick<CaseRepository, "load" | "applyEvents">;
  requireTakeover?: RequireTakeover;
  rateLimiter?: RateLimiter;
  paymentsModeOverride?: () => Promise<PaymentsMode | null>;
  core?: ToolCore;
  rating?: RatingSource;
}

export interface Wp6 {
  payments: PaymentService;
  tools: Wp6ToolService;
  toolStore: ToolStore;
  requireTakeover: RequireTakeover;
  rateLimiter: RateLimiter;
  webhookSecret: string | null;
  appUrl: string | null;
}

let cfg: Wp6Config = {};
let built: Wp6 | null = null;

/** Inject other WPs' implementations (integrator, G1). Rebuilds the services on next use. */
export function configureWp6(c: Wp6Config): void {
  cfg = { ...cfg, ...c };
  if (c.core) setToolCore(c.core);
  built = null;
}

/** Replace the whole composition (route tests). `null` resets to the defaults. */
export function setWp6(w: Wp6 | null): void {
  built = w;
}

const notWiredCases: Pick<CaseRepository, "load" | "applyEvents"> = {
  load: async () => {
    throw new BatonError("E_INTERNAL", "The tool layer is not wired to the case repository yet (configureWp6({cases})).");
  },
  applyEvents: async () => {
    throw new BatonError("E_INTERNAL", "The tool layer is not wired to the case repository yet (configureWp6({cases})).");
  },
};

export function wp6(): Wp6 {
  if (built) return built;
  const e = env();
  const db = getDb();
  const polarReady = !!e.POLAR_ACCESS_TOKEN && !!e.POLAR_PRODUCT_ID;
  const payStore = new DbPaymentStore(db);
  const toolStore = new DbToolStore(db);
  let tools: Wp6ToolService | null = null;
  const payments = new PaymentService({
    store: payStore,
    polar: polarReady ? sdkPolarApi({ accessToken: e.POLAR_ACCESS_TOKEN!, server: e.POLAR_SERVER }) : null,
    polarConfig: polarReady
      ? { productId: e.POLAR_PRODUCT_ID!, demoCustomers: e.POLAR_DEMO_CUSTOMERS ?? {}, embedOrigins: e.EMBED_ORIGINS, appUrl: e.APP_URL ?? null }
      : null,
    mode: async () => (await cfg.paymentsModeOverride?.().catch(() => null)) ?? e.PAYMENTS_MODE,
    stagePayloadFor: (p) => (tools ? tools.stagePayloadFor(p) : Promise.resolve(null)),
  });
  tools = new Wp6ToolService({
    cases: cfg.cases ?? notWiredCases,
    store: toolStore,
    payments,
    core: getToolCore,
    rating: cfg.rating ?? kitRatingSource,
    config: {
      deployId: e.BATON_DEPLOY_ID,
      payToolMode: e.PAY_TOOL_MODE,
      // Not in env.ts yet (request wp6-to-integrator): read directly, "1" = on.
      taxSuffix: process.env.DISCLOSURE_TAX_SUFFIX?.trim() === "1",
    },
  });
  built = {
    payments,
    tools,
    toolStore,
    requireTakeover: cfg.requireTakeover ?? jwtRequireTakeover,
    rateLimiter: cfg.rateLimiter ?? memoryRateLimiter,
    webhookSecret: e.POLAR_WEBHOOK_SECRET ?? null,
    appUrl: e.APP_URL ?? null,
  };
  if (!cfg.requireTakeover) authLog.warn("using the fallback case-token check (no visitor match) until WP2's requireCase is wired");
  return built;
}

const authLog = log.child({ component: "wp6-auth" });

/**
 * Fallback auth until WP2's `requireCase` is wired: verifies the case JWT of DESIGN §4.3 (HS256 with
 * CASE_TOKEN_SECRET; `sub` = caseId, `vid`, `scp` ∋ scope, `tko` = the takeover). It cannot match the visitor
 * cookie (that is WP2's), so the integrator MUST replace it at G1.
 */
export const jwtRequireTakeover: RequireTakeover = async (req, want) => {
  const h = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  if (!m) throw new BatonError("E_CASE_TOKEN", "Missing case token.");
  const secret = env().CASE_TOKEN_SECRET;
  if (!secret) throw new BatonError("E_INTERNAL", "CASE_TOKEN_SECRET is not configured (value never printed)");
  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(m[1]!.trim(), new TextEncoder().encode(secret), { algorithms: ["HS256"] }));
  } catch {
    throw new BatonError("E_CASE_TOKEN", "The case token is not valid.");
  }
  const scp = Array.isArray(payload.scp) ? payload.scp : [];
  if (typeof payload.sub !== "string" || typeof payload.vid !== "string") throw new BatonError("E_CASE_TOKEN", "The case token is malformed.");
  if (!scp.includes(want.scope)) throw new BatonError("E_FORBIDDEN", "The token lacks the required scope.");
  if (payload.tko !== want.takeoverId) throw new BatonError("E_FORBIDDEN", "The token is not for this takeover.");
  return { caseId: payload.sub, visitorId: payload.vid, takeoverId: typeof payload.tko === "string" ? payload.tko : null };
};

/** In-process fixed-window limiter (default until WP2's DB limiter is wired; per container, best-effort). */
const windows = new Map<string, { start: number; used: number }>();
export const memoryRateLimiter: RateLimiter = {
  async hit(bucket, key, limit, windowSec, cost = 1) {
    const now = Date.now();
    const k = `${bucket}:${key}`;
    const w = windows.get(k);
    if (!w || now - w.start >= windowSec * 1000) {
      windows.set(k, { start: now, used: cost });
      if (windows.size > 10_000) for (const [kk, ww] of windows) if (now - ww.start > 3_600_000) windows.delete(kk);
      return { ok: cost <= limit, retryAfterSec: 0 };
    }
    if (w.used + cost > limit) return { ok: false, retryAfterSec: Math.max(1, Math.ceil((w.start + windowSec * 1000 - now) / 1000)) };
    w.used += cost;
    return { ok: true, retryAfterSec: 0 };
  },
};

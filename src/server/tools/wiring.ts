import "server-only";

import { jwtVerify } from "jose";

import type { CaseState } from "../../core/contracts/case";
import { BatonError } from "../../core/contracts/errors";
import type { CaseRepository, RateLimiter } from "../../core/contracts/services";
import { getDb } from "../db/client";
import { env } from "../env";
import { PaymentService, type PaymentsMode } from "../payments/service";
import { DbPaymentStore } from "../payments/store";
import { sdkPolarApi } from "../polar/client";
import { kitRatingSource, type RatingSource } from "../rating";
import { getConnectorCallLog } from "../connectors";
import { RelayConnectorRuntime } from "../connectors/runtime";
import { getToolCore, hasToolCore, setToolCore, type ToolCore } from "./core-port";
import { defaultRelayRunSource, type RelayRunSource } from "./relay-run-source";
import { RelayToolServiceImpl } from "./relay-tool-service";
import { wp1ToolCore, wp2PaymentsModeOverride, wp2RateLimiter, wp2RequireTakeover, wp3CaseSink } from "./defaults";
import { Wp6ToolService } from "./service";
import { DbToolStore, type ToolStore } from "./store";

/**
 * WP6 composition root: the routes (#14–#18) call `wp6()`. Since G1 (WP1, WP2 and WP3 on main) the defaults are the
 * real implementations (`./defaults.ts`):
 * - `cases`: WP3's `CaseRepository` (`load`, `applyEvents`, `setCaseExtras`);
 * - `requireTakeover`: WP2's `requireCase(req, {takeoverId, scope})` (case JWT + visitor-cookie match);
 * - `rateLimiter`: WP2's `getRateLimiter()` (DB fixed window);
 * - `paymentsModeOverride`: WP2's flags (`app_flags.payments_mode_override`);
 * - `core`: WP1's functions (`wp1ToolCore`); `rating`: the kit table (`kitRatingSource`).
 * Tests (and, after G2, WP16's `RelayToolService`) replace any of them with `configureWp6({...})` or `setWp6(...)`.
 */

export interface TakeoverAuth {
  caseId: string;
  visitorId: string;
  takeoverId: string | null;
}
export type RequireTakeover = (req: Request, want: { takeoverId: string; scope: "tools" | "case" }) => Promise<TakeoverAuth>;

/**
 * What the tool layer needs from the case repository. `setCaseExtras` mirrors the non-derivable flow parts (stage,
 * disclosures given, payment, confirmation number) into `cases.state` under the case lock (wp3-to-wp6 item 2), so
 * route #4 and the console see them; WP6's own tables stay authoritative for the handlers.
 */
export type CaseSink = Pick<CaseRepository, "load" | "applyEvents"> & {
  setCaseExtras?(caseId: string, patch: Partial<Pick<CaseState, "stage" | "disclosuresGiven" | "payment" | "confirmationNumber">>): Promise<unknown>;
};

export interface Wp6Config {
  cases?: CaseSink;
  requireTakeover?: RequireTakeover;
  rateLimiter?: RateLimiter;
  paymentsModeOverride?: () => Promise<PaymentsMode | null>;
  core?: ToolCore;
  rating?: RatingSource;
  /** WP16·2: where the generic service finds a case's relay version, compiled relay and account. */
  runs?: RelayRunSource;
}

export interface Wp6 {
  payments: PaymentService;
  tools: Wp6ToolService;
  toolStore: ToolStore;
  requireTakeover: RequireTakeover;
  rateLimiter: RateLimiter;
  webhookSecret: string | null;
  appUrl: string | null;
  /**
   * WP16·2 (PLATFORM §6.3 "`/api/tools/[name]` resolves the case"): the generic service, and what the route needs to
   * choose between it and the legacy Baton one. `null` (route tests that only exercise WP6) keeps every call legacy.
   */
  relayTools?: RelayToolServiceImpl | null;
  relayCaseOf?: (caseId: string) => Promise<{ relayVersionId: string | null; mode: string } | null>;
  /** `RELAY_ENGINE`: with `kernel`, even a version-less Baton case runs on the kernel (PLATFORM §4.6). */
  relayEngine?: "legacy" | "kernel";
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
    mode: async () => (await (cfg.paymentsModeOverride ?? wp2PaymentsModeOverride)().catch(() => null)) ?? e.PAYMENTS_MODE,
    stagePayloadFor: (p) => (tools ? tools.stagePayloadFor(p) : Promise.resolve(null)),
    extrasFor: (p, origin) => (tools ? tools.extrasFor(p, origin) : Promise.resolve(null)),
  });
  tools = new Wp6ToolService({
    cases: cfg.cases ?? wp3CaseSink(),
    store: toolStore,
    payments,
    core: () => (hasToolCore() ? getToolCore() : wp1ToolCore),
    rating: cfg.rating ?? kitRatingSource,
    config: {
      deployId: e.BATON_DEPLOY_ID,
      payToolMode: e.PAY_TOOL_MODE,
      // Not in env.ts yet (request wp6-to-integrator): read directly, "1" = on.
      taxSuffix: process.env.DISCLOSURE_TAX_SUFFIX?.trim() === "1",
    },
  });
  const runs = cfg.runs ?? defaultRelayRunSource();
  built = {
    payments,
    tools,
    toolStore,
    requireTakeover: cfg.requireTakeover ?? wp2RequireTakeover,
    rateLimiter: cfg.rateLimiter ?? wp2RateLimiter(),
    webhookSecret: e.POLAR_WEBHOOK_SECRET ?? null,
    appUrl: e.APP_URL ?? null,
    relayTools: new RelayToolServiceImpl({
      runs,
      cases: cfg.cases ?? wp3CaseSink(),
      store: toolStore,
      payments,
      connectors: buildConnectorRuntime({ payments, store: toolStore }),
      callLog: getConnectorCallLog(),
      config: { deployId: e.BATON_DEPLOY_ID, taxSuffix: process.env.DISCLOSURE_TAX_SUFFIX?.trim() === "1" },
    }),
    relayCaseOf: (caseId) => runs.loadCase(caseId),
    // Not in EnvSchema yet (request wp16-to-wp12 §2): read directly, and default to the submission setting.
    relayEngine: process.env.RELAY_ENGINE?.trim() === "kernel" ? "kernel" : "legacy",
  };
  return built;
}

/**
 * WP16·2, for WP18's published gateway (`docs/notes/requests/wp18-to-wp16.md` §1): the ONE `RelayToolService` this
 * process runs. It is the same instance `/api/tools/[name]` uses, so a test run and a published run of the same
 * relay cannot end up on two different stage gates or two different connector runtimes.
 *
 * `setPublishDeps({ tools: getRelayToolService })` registers it; see `docs/notes/requests/wp16-to-wp18.md` for why
 * WP18 owns that line (the gateway route is theirs, and a module-level side effect here would depend on which route
 * Next.js loaded first).
 */
export function getRelayToolService(): RelayToolServiceImpl | null {
  return wp6().relayTools ?? null;
}

/**
 * WP16·2: the `ConnectorRuntime` the generic service dispatches through — the SSRF-guarded HTTP path and the
 * `connector_calls` log from WP16·1, plus the built-ins' two side effects (create a payment, write a takeover
 * metric). The secret store is resolved lazily so a process without `AGENT_TOOL_SECRET` still serves Baton.
 */
export function buildConnectorRuntime(d: { payments: PaymentService; store: ToolStore }): RelayConnectorRuntime {
  return new RelayConnectorRuntime({
    secrets: {
      resolve: async (ws, ref) => (await import("../secrets")).getSecretStore().resolve(ws, ref),
      nameOf: async (ws, ref) => (await import("../secrets")).getSecretStore().nameOf(ws, ref),
    },
    callLog: getConnectorCallLog(),
    payments: { create: (i) => d.payments.create(i) },
    store: {
      markConnector: (id, r) => d.store.markConnector(id, r),
      putConfirmationNumber: (id, n) => d.store.putConfirmationNumber(id, n),
      setCaseStatus: (caseId, status, from) => d.store.setCaseStatus(caseId, status, from),
    },
  });
}

/**
 * The case-JWT check without the visitor-cookie match (DESIGN §4.3: HS256 with CASE_TOKEN_SECRET; `sub` = caseId,
 * `vid`, `scp` ∋ scope, `tko` = the takeover). Route tests and the dev lab use it; production uses WP2's `requireCase`.
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

/** In-process fixed-window limiter (route tests; production uses WP2's DB limiter). */
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

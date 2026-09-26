import "server-only";

import { BatonError } from "../../core/contracts/errors";
import type { KernelBinding, SimCallResolver } from "../../core/contracts/ext/wp14b-engine";
import type { CallManifestEntry } from "../../core/contracts/scenario";
import type { RateLimiter } from "../../core/contracts/services";
import { workspaceOf, type Blueprint, type CompiledRelayView, type LintIssue } from "../../core/contracts/v2";
import type { Principal } from "../../core/contracts/v3/identity";
import type { Permission } from "../../core/contracts/v3/permissions";
import { requireVisitor } from "../auth/visitor";
import { getCaseDataSource } from "../data";
import { getDb, type Db } from "../db/client";
import { RelayCallCatalog } from "../engine/catalog";
import { compiledRelayView } from "../engine/compile-view";
import { CachedRelayEngineFactory } from "../engine/factory";
import { getKernelBinding } from "../engine/kernel-binding";
import { env } from "../env";
import { getLimitsAuthority, getRateLimiter } from "../limits";
import { log } from "../log";
import { createOpenAI } from "../openai/client";
import { SaasError } from "../saas/errors";
import { requirePrincipal } from "../saas/principal";
import { RelayError } from "./http";
import { hasLintErrors, type RelayKernel } from "./kernel";
import { OpenAIModerator, type Moderator } from "./moderation";
import { PgGuestSeeder } from "./guest-seeder";
import { PgRelayRegistry, type PublicationLookup } from "./registry";
import { installRelaySaas } from "./saas";
import { PgRelaySourceStore } from "./source-store";
import { FLAGSHIP_FILES, FsGallerySource, type GallerySource, type SeedResult } from "./seed";

/**
 * WP14b's relay service graph (one per process), like `src/server/cases/index.ts`: routes call `getRelaysDeps()`;
 * tests and later units inject parts with `setRelaysDeps({...})` (anything left out is built from the defaults).
 *
 * WP14b·2 adds the engine half: the `RelayEngineFactory` (LRU over registry versions), the `CallCatalog` (recorded
 * calls, then WP17's sims), the kernel binding (`src/server/engine/kernel-binding.ts`), the OpenAI moderator (free
 * endpoint, $0 ledger rows) and the server compile behind `GET /:id/compiled`.
 *
 * The gallery seed runs once per process, lazily, before the first relay request is answered (`ensureSeeded`), so a
 * fresh container serves the gallery without a manual step (PLATFORM §14 Q4: "the relay seed runs automatically at
 * start-up"). A failed seed is logged and retried on the next request; it never fails the request itself.
 */
export interface RelaysVisitor {
  visitorId: string;
  ipKey: string;
}

/** `GET /api/relays/:id/compiled`: the server's authoritative compile (PLATFORM §7.3). */
export type CompileView = (i: { relayId: string; versionId: string | null; blueprint: Blueprint; lint: LintIssue[]; flagship: boolean }) => Promise<CompiledRelayView>;

export interface RelaysDeps {
  db: Db;
  registry: PgRelayRegistry;
  requireVisitor(req: { headers: Headers }): RelaysVisitor;
  rateLimiter(): RateLimiter;
  ensureSeeded(): Promise<SeedResult | null>;
  /** The server compile (answers 503 E_MAINTENANCE while the kernel binding is null). */
  compileView: CompileView;
  /** `RelayEngineFactory` over this registry's versions (LRU 50; `forVersion(null)` = the flagship file). */
  engine: CachedRelayEngineFactory;
  /** `CallCatalog`: generated calls, then WP17's sims (bound at G2b). */
  catalog: RelayCallCatalog;
  /** WP14a's kernel, or null until it is on main (`kernel-binding.ts`). */
  binding(): KernelBinding | null;
}

export interface RelaysDepsOverrides {
  db?: Db;
  kernel?: RelayKernel;
  now?: () => number;
  caps?: { softLive: number; hardLive: number; idleMs: number };
  moderator?: Moderator | null;
  publications?: PublicationLookup | null;
  gallery?: GallerySource | null;
  requireVisitor?: (req: { headers: Headers }) => RelaysVisitor;
  rateLimiter?: () => RateLimiter;
  compileView?: CompileView;
  /** Default: `getKernelBinding()` (read at each use). */
  binding?: () => KernelBinding | null;
  /** WP17's `SimCallStore` (default since G2b: `getSimCallStore()`, resolved lazily). */
  sims?: () => SimCallResolver | null;
  /** Recorded calls (default: WP3's `getCaseDataSource()`). */
  calls?: { getCall(callId: string): Promise<CallManifestEntry | null> };
  engineCapacity?: number;
  deployId?: () => string;
}

const relaysLog = log.child({ component: "relays" });

const deployIdOf = (): string => env().BATON_DEPLOY_ID;

/**
 * [WIRE-SIMS] / [WIRE-PUBLICATIONS], bound at G2b.
 *
 * Both defaults were `null` while `wp/wp17` and `wp/wp18` were off `main`, which left `CallCatalog` unable to resolve
 * any simulated call and `RelayDetail.publication` permanently null (`docs/notes/requests/wp14b-to-wp17.md` §4 and
 * `wp18-to-wp14b.md` §3; both notes hand the one-line binding to the integrator).
 *
 * They are bound through `await import(...)` rather than a top-level import on purpose: `src/server/publish/deps.ts`
 * and `src/server/sim/service.ts` both import `getRelaysDeps` from this module, so a static import here would close a
 * cycle. The dynamic form also keeps the graph lazy — neither module (and so neither `getDb()`) is touched until a
 * request actually resolves a sim or reads a relay's publication.
 */
const defaultSims = (): SimCallResolver => ({
  resolveCall: async (callId) => (await import("../sim/defaults")).getSimCallStore().resolveCall(callId),
});

const defaultPublications = (): PublicationLookup => ({
  forRelay: async (relayId) => (await import("../publish")).publicationLookup().forRelay(relayId),
});

/**
 * The default moderator: OpenAI `omni-moderation-latest` (free) with a $0 ledger reserve/settle per call (TASKS-v2 §2
 * rule 6). A missing `OPENAI_API_KEY` or ledger surfaces as "unavailable" at check time (the policy decides).
 */
export function defaultModerator(deployId: () => string = deployIdOf): Moderator {
  return new OpenAIModerator({
    client: () => {
      const key = env().OPENAI_API_KEY;
      if (!key) throw new Error("OPENAI_API_KEY is not configured (value never printed)");
      return createOpenAI(key, { maxRetries: 0 });
    },
    ledger: () => getLimitsAuthority().ledger,
    env: deployId,
  });
}

/** The flagship gallery file (`forVersion(null)`), parsed and hashed; cached once it loads (a miss is retried). */
function legacyFlagship(gallery: GallerySource | null, kernel: RelayKernel): () => Promise<{ blueprint: Blueprint; hash: string } | null> {
  let loaded: Promise<{ blueprint: Blueprint; hash: string } | null> | null = null;
  return () => {
    if (loaded) return loaded;
    const cur = (async () => {
      if (!gallery) return null;
      const { entries } = await gallery.load();
      const e = entries.find((x) => x.file === FLAGSHIP_FILES[0]);
      const p = e ? kernel.parse(e.json) : null;
      if (!p?.blueprint) return null;
      return { blueprint: p.blueprint, hash: kernel.hash(p.blueprint) };
    })();
    loaded = cur;
    const forget = () => {
      if (loaded === cur) loaded = null;
    };
    cur.then((v) => (v ? undefined : forget()), forget);
    return cur;
  };
}

/** Point WP19's three port slots at a given relay graph (WP14b·4). Overwrites; never "install once". */
function registerRelaySaasPorts(
  db: Db,
  registry: PgRelayRegistry,
  now?: () => number,
  ensureGallery?: () => Promise<unknown>,
): void {
  installRelaySaas({
    db,
    sourceStore: new PgRelaySourceStore({ registry, ...(now ? { now } : {}) }),
    seeder: new PgGuestSeeder({
      db: () => db,
      kernel: registry.kernel,
      ...(now ? { now } : {}),
      // G3: the guest seeder copies a gallery relay, so it has to be able to fill the gallery itself. See
      // `PgGuestSeederOptions.ensureGallery` — `/api/guest/start` is the one caller that never lists relays.
      ...(ensureGallery ? { ensureGallery } : {}),
    }),
  });
}

export function buildRelaysDeps(o: RelaysDepsOverrides = {}): RelaysDeps {
  const db = o.db ?? getDb();
  const deployId = o.deployId ?? deployIdOf;
  const gallery = o.gallery === undefined ? new FsGallerySource() : o.gallery;
  const registry = new PgRelayRegistry({
    db,
    ...(o.kernel ? { kernel: o.kernel } : {}),
    ...(o.now ? { now: o.now } : {}),
    ...(o.caps ? { caps: o.caps } : {}),
    moderator: o.moderator === undefined ? defaultModerator(deployId) : o.moderator,
    publications: o.publications === undefined ? defaultPublications() : o.publications,
    gallery,
  });
  const binding = o.binding ?? (() => getKernelBinding());
  const engine = new CachedRelayEngineFactory({
    versions: registry,
    compiler: () => binding()?.compile ?? null,
    legacyBlueprint: legacyFlagship(gallery, registry.kernel),
    ...(o.engineCapacity ? { capacity: o.engineCapacity } : {}),
  });
  const catalog = new RelayCallCatalog({
    calls: o.calls ?? { getCall: (id) => getCaseDataSource().getCall(id) },
    sims: o.sims ?? (() => defaultSims()),
    versions: registry,
  });
  const compileView: CompileView = o.compileView ?? (async (i) => {
    const b = binding();
    if (!b) throw new BatonError("E_MAINTENANCE", "The server compiler is not available yet; the Studio's local preview still works.");
    if (hasLintErrors(i.lint)) throw new RelayError("E_LINT", "Fix the lint errors to see the server compile.", { lint: i.lint });
    const compiled = i.versionId
      ? await engine.forVersion(i.versionId)
      : b.compile(i.blueprint, { versionId: null, relayId: i.relayId, hash: registry.kernel.hash(i.blueprint), flagship: i.flagship });
    return compiledRelayView({ ...i, compiled, binding: b, deployId: deployId() });
  });
  let seeding: Promise<SeedResult | null> | null = null;
  const ensureSeeded = (): Promise<SeedResult | null> => {
    seeding ??= registry.seedGallery().catch((err: unknown) => {
      relaysLog.error("gallery seed failed; retrying on the next request", { err });
      seeding = null;
      return null;
    });
    return seeding;
  };

  // WP14b·4: the ports WP19 declared and left for this unit (SAAS §14). Registering them here means a route, a
  // script and a test all get the real store and seeder the moment they touch the relay graph, with no separate
  // bootstrap call to forget. `installRelaySaas` is idempotent.
  registerRelaySaasPorts(db, registry, o.now, ensureSeeded);

  return {
    db,
    registry,
    requireVisitor: o.requireVisitor ?? ((req) => requireVisitor(req)),
    rateLimiter: o.rateLimiter ?? (() => getRateLimiter()),
    compileView,
    engine,
    catalog,
    binding,
    ensureSeeded,
  };
}

type Holder = { deps: RelaysDeps | null };
const g = globalThis as typeof globalThis & { __batonRelays?: Holder };
const holder: Holder = (g.__batonRelays ??= { deps: null });

export function getRelaysDeps(): RelaysDeps {
  holder.deps ??= buildRelaysDeps();
  return holder.deps;
}

/**
 * [WIRE-RELAY-SAAS] Boot-time registration of WP14b's v3 ports (WP14b·4; SAAS §3.3 step 5, §14).
 *
 * `installRelaySaas` runs as a side effect of building the relay graph, and the graph is built lazily on the first
 * touch of `/api/relays/**`. That is too late for one caller: **`/api/guest/start` never touches the relay graph**
 * (`src/server/identity/guest-start.ts` imports `getGuestSeeder` from the ports registry and nothing else of
 * WP14b's). In a cold container whose first request is a guest start — which is exactly the judge path, and the
 * landing CTA's background start — the port registry would still hold WP19's no-op default, and the guest would
 * land in an empty workspace with no Dental copy. The bug is invisible in tests and in any warm process, because
 * anything that lists relays first installs the real seeder.
 *
 * So the graph is built once at boot instead, the same way WP18's `installPublishing()` is (`src/instrumentation.ts`
 * `[WIRE-PUBLISHING]`). It is cheap and opens no database connection: `getDb()` wraps a `pg` `Pool` that does not
 * connect until its first query, and every other node of the graph is plain object construction.
 *
 * Idempotent, and a **re-register rather than a build**: calling it after the graph already exists re-points the
 * three port slots at that same graph, so it is also the repair for a process whose ports were cleared.
 */
export function installRelaySaasPorts(): void {
  const d = getRelaysDeps();
  registerRelaySaasPorts(d.db, d.registry, undefined, d.ensureSeeded);
}

/** Tests and scripts: replace the graph (null = rebuild from the defaults on next use). */
export function setRelaysDeps(o: RelaysDepsOverrides | null): RelaysDeps | null {
  holder.deps = o ? buildRelaysDeps(o) : null;
  return holder.deps;
}

/** The request's workspace (`ws_<visitorId>`), from the signed visitor cookie or `x-baton-visitor` header. */
export function workspaceFor(d: RelaysDeps, req: { headers: Headers }): { visitor: RelaysVisitor; ws: string } {
  const visitor = d.requireVisitor(req);
  return { visitor, ws: workspaceOf(visitor.visitorId) };
}

/**
 * The principal of an `/api/relays/**` request (WP14b·4; SAAS §2.3, §10.1 rule 3). **This is the only place these
 * routes learn which workspace they are in**: `ws = principal.orgId`, never a body field, a query string or a
 * header.
 *
 * Under `TENANCY_MODE=legacy` the resolver returns the v2 device principal, whose `orgId` is exactly the
 * `ws_<visitorId>` that `workspaceFor` computes — which is why the v2 route tests pass unchanged. Under `orgs` it
 * is the session's (or API key's) org, and the same handler is suddenly multi-tenant without a second code path.
 *
 * `visitor` stays on the result because the v2 per-device rate buckets (`RELAY_RATES.createVisitor` / `createIp`)
 * are device buckets by design (SAAS §4.2 I1) and outlive the org adoption; an API-key request buckets on a fresh
 * random id per call, which §4.2 names honestly rather than pretending it is a control.
 */
export async function relayPrincipal(req: Request, perm: Permission): Promise<{ principal: Principal; visitor: RelaysVisitor; ws: string }> {
  const principal = await requirePrincipal(req, { perm });
  if (!principal.orgId) throw new SaasError("E_AUTH_REQUIRED", "Start a free workspace to continue.");
  return { principal, visitor: { visitorId: principal.visitorId, ipKey: principal.ipKey }, ws: principal.orgId };
}

export { PgRelayRegistry, stripSecrets, type PublicationLookup } from "./registry";
export { FsGallerySource, MemoryGallerySource, seedGallery, type GalleryEntry, type GallerySource, type SeedResult } from "./seed";
export { defaultRelayKernel, hasLintErrors, type RelayKernel } from "./kernel";
export { RelayError, relayRoute } from "./http";
export { ModerationUnavailableError, OpenAIModerator, type Moderator } from "./moderation";

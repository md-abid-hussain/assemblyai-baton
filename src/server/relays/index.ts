import "server-only";

import { BatonError } from "../../core/contracts/errors";
import type { KernelBinding, SimCallResolver } from "../../core/contracts/ext/wp14b-engine";
import type { CallManifestEntry } from "../../core/contracts/scenario";
import type { RateLimiter } from "../../core/contracts/services";
import { workspaceOf, type Blueprint, type CompiledRelayView, type LintIssue } from "../../core/contracts/v2";
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
import { RelayError } from "./http";
import { hasLintErrors, type RelayKernel } from "./kernel";
import { OpenAIModerator, type Moderator } from "./moderation";
import { PgRelayRegistry, type PublicationLookup } from "./registry";
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
  /** `CallCatalog`: generated calls, then WP17's sims. */
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
  /** WP17's `SimCallStore` (`getSimCallStore()`), null until it is on main. */
  sims?: () => SimCallResolver | null;
  /** Recorded calls (default: WP3's `getCaseDataSource()`). */
  calls?: { getCall(callId: string): Promise<CallManifestEntry | null> };
  engineCapacity?: number;
  deployId?: () => string;
}

const relaysLog = log.child({ component: "relays" });

const deployIdOf = (): string => env().BATON_DEPLOY_ID;

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
    publications: o.publications ?? null,
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
    sims: o.sims ?? (() => null),
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
  return {
    db,
    registry,
    requireVisitor: o.requireVisitor ?? ((req) => requireVisitor(req)),
    rateLimiter: o.rateLimiter ?? (() => getRateLimiter()),
    compileView,
    engine,
    catalog,
    binding,
    ensureSeeded() {
      seeding ??= registry.seedGallery().catch((err: unknown) => {
        relaysLog.error("gallery seed failed; retrying on the next request", { err });
        seeding = null;
        return null;
      });
      return seeding;
    },
  };
}

type Holder = { deps: RelaysDeps | null };
const g = globalThis as typeof globalThis & { __batonRelays?: Holder };
const holder: Holder = (g.__batonRelays ??= { deps: null });

export function getRelaysDeps(): RelaysDeps {
  holder.deps ??= buildRelaysDeps();
  return holder.deps;
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

export { PgRelayRegistry, stripSecrets, type PublicationLookup } from "./registry";
export { FsGallerySource, MemoryGallerySource, seedGallery, type GalleryEntry, type GallerySource, type SeedResult } from "./seed";
export { defaultRelayKernel, hasLintErrors, type RelayKernel } from "./kernel";
export { RelayError, relayRoute } from "./http";
export { ModerationUnavailableError, OpenAIModerator, type Moderator } from "./moderation";

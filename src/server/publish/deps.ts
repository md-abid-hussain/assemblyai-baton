import "server-only";

/**
 * server/publish/deps.ts - WP18's composition root (the `src/server/relays/index.ts` pattern): routes call
 * `getPublishDeps()`; tests and later units inject parts with `setPublishDeps({...})`.
 *
 * The seams that are not on `main` yet:
 *  - **`tools`**: WP16's `RelayToolService` (PLATFORM §6.3), which the gateway dispatches every published tool call
 *    through. Null until WP16·2/·3 registers it — the gateway then answers `{status:"unavailable"}` rather than 500.
 *  - **`secretIds`**: WP16's `SecretStore.list(ws)`, for lint K2 at publish time (a null/expired secret ref must not
 *    reach a published agent). Undefined → K2 only fails refs that are literally `null`, which is the Studio's rule.
 *
 * Everything else comes from WP14b's relay graph (`getRelaysDeps()`: db, registry, engine) and WP8's `va-rest`.
 */
import type { RateLimiter } from "../../core/contracts/services";
import type { RelayToolService } from "../../core/contracts/v2/services";
import { defaultVaRest, type VaRestPort } from "../aai/va-rest";
import type { Db } from "../db/client";
import { env } from "../env";
import { getRelaysDeps } from "../relays";
import type { CachedRelayEngineFactory } from "../engine/factory";
import type { PgRelayRegistry } from "../relays/registry";

export interface PublishDeps {
  db: Db;
  registry: PgRelayRegistry;
  engine: Pick<CachedRelayEngineFactory, "forVersion">;
  vaRest(): VaRestPort;
  /** WP16's generic tool service; null until it is wired. */
  tools(): RelayToolService | null;
  rateLimiter(): RateLimiter;
  now(): number;
  deployId(): string;
  /** Absolute origin the published HTTP tools point at. Publishing refuses without it (AssemblyAI must reach us). */
  appUrl(): string | null;
  /** WP16: the ids of the workspace's live secrets, for lint K2. Undefined → the null-ref-only rule. */
  secretIds?: ((ws: string) => Promise<readonly string[]>) | undefined;
}

export interface PublishDepsOverrides {
  db?: Db;
  registry?: PgRelayRegistry;
  engine?: Pick<CachedRelayEngineFactory, "forVersion">;
  vaRest?: () => VaRestPort;
  tools?: () => RelayToolService | null;
  rateLimiter?: () => RateLimiter;
  now?: () => number;
  deployId?: () => string;
  appUrl?: () => string | null;
  secretIds?: (ws: string) => Promise<readonly string[]>;
}

export function buildPublishDeps(o: PublishDepsOverrides = {}): PublishDeps {
  const relays = o.db && o.registry && o.engine ? null : getRelaysDeps();
  let rest: VaRestPort | null = null;
  return {
    db: o.db ?? relays!.db,
    registry: o.registry ?? relays!.registry,
    engine: o.engine ?? relays!.engine,
    vaRest: o.vaRest ?? (() => (rest ??= defaultVaRest())),
    tools: o.tools ?? (() => null),
    rateLimiter: o.rateLimiter ?? (() => getRelaysDeps().rateLimiter()),
    now: o.now ?? Date.now,
    deployId: o.deployId ?? (() => env().BATON_DEPLOY_ID),
    appUrl: o.appUrl ?? (() => env().APP_URL ?? null),
    ...(o.secretIds ? { secretIds: o.secretIds } : {}),
  };
}

type Holder = { deps: PublishDeps | null };
const g = globalThis as typeof globalThis & { __changeoverPublish?: Holder };
const holder: Holder = (g.__changeoverPublish ??= { deps: null });

export function getPublishDeps(): PublishDeps {
  holder.deps ??= buildPublishDeps();
  return holder.deps;
}

/** Tests, scripts and the WP16 wiring: replace the graph (null = rebuild from the defaults on next use). */
export function setPublishDeps(o: PublishDepsOverrides | null): PublishDeps | null {
  holder.deps = o ? buildPublishDeps(o) : null;
  return holder.deps;
}

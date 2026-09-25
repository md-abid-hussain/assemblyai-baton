import "server-only";

import { BatonError } from "../../core/contracts/errors";
import { ENGINE_CACHE_SIZE, type RelayCompiler } from "../../core/contracts/ext/wp14b-engine";
import type { Blueprint, CompiledRelay, RelayEngineFactory } from "../../core/contracts/v2";
import { log } from "../log";
import type { RunVersion } from "../relays/registry";

/**
 * `RelayEngineFactory` (TASKS-v2 §5, WP14b·2): the compiled relay for a version, from an LRU of `ENGINE_CACHE_SIZE`
 * (versions are immutable, so an entry never goes stale). Concurrent misses for one version share one compile, and a
 * failed compile is not cached.
 *
 * - `forVersion(versionId)`: the registry's version (whatever its relay's status; runs of archived relays still
 *   compile), compiled with `flagship` from its relay row (only the seeded Baton relay skips the kernel safety block).
 * - `forVersion(null)`: the legacy Baton path, i.e. the flagship gallery file `data/relays/baton-add-driver.json`
 *   compiled with `flagship: true, versionId: null`. Parity (PLATFORM §4.6) makes it equal to the legacy compiler, and
 *   the legacy case engine still drives Baton runs (P3); this relay only supplies the v2 response fields.
 * - The compiler is WP14a's `compileRelay`, injected (`compiler.ts`). Until it is on main, every compile answers
 *   503 E_MAINTENANCE and Baton keeps its v1 behaviour.
 */
export interface EngineVersionSource {
  runVersion(versionId: string): Promise<RunVersion | null>;
}

export interface CachedRelayEngineFactoryDeps {
  versions: EngineVersionSource;
  compiler: RelayCompiler | null;
  /** The flagship blueprint for `forVersion(null)`, parsed, with its content hash; null when the file is missing. */
  legacyBlueprint: () => Promise<{ blueprint: Blueprint; hash: string } | null>;
  capacity?: number;
}

const engineLog = log.child({ component: "engine" });
const LEGACY_KEY = "\u0000legacy";

export class CachedRelayEngineFactory implements RelayEngineFactory {
  private readonly lru = new Map<string, Promise<CompiledRelay>>();
  private readonly capacity: number;

  constructor(private readonly d: CachedRelayEngineFactoryDeps) {
    this.capacity = Math.max(1, d.capacity ?? ENGINE_CACHE_SIZE);
  }

  /** True when a kernel compiler is wired (else every `forVersion` is a 503). */
  get available(): boolean {
    return this.d.compiler !== null;
  }

  forVersion(versionId: string | null): Promise<CompiledRelay> {
    const key = versionId ?? LEGACY_KEY;
    const hit = this.lru.get(key);
    if (hit) {
      this.lru.delete(key);
      this.lru.set(key, hit);
      return hit;
    }
    const p = this.build(versionId);
    this.lru.set(key, p);
    while (this.lru.size > this.capacity) {
      const oldest = this.lru.keys().next().value as string;
      this.lru.delete(oldest);
    }
    p.catch(() => {
      if (this.lru.get(key) === p) this.lru.delete(key);
    });
    return p;
  }

  /** Cached keys, least recently used first (tests, `/api/status` diagnostics). */
  cachedKeys(): string[] {
    return [...this.lru.keys()].map((k) => (k === LEGACY_KEY ? "legacy" : k));
  }

  clear(): void {
    this.lru.clear();
  }

  private async build(versionId: string | null): Promise<CompiledRelay> {
    const compile = this.d.compiler;
    if (!compile) throw new BatonError("E_MAINTENANCE", "The relay engine is not available yet.");
    if (versionId === null) {
      const legacy = await this.d.legacyBlueprint();
      if (!legacy) throw new BatonError("E_MAINTENANCE", "The flagship relay file is missing.");
      return compile(legacy.blueprint, { versionId: null, relayId: null, hash: legacy.hash, flagship: true });
    }
    const v = await this.d.versions.runVersion(versionId);
    if (!v) throw new BatonError("E_NOT_FOUND", "No such relay version.");
    const t0 = Date.now();
    const compiled = compile(v.blueprint, { versionId, relayId: v.relayId, hash: v.hash, flagship: v.flagship });
    engineLog.info("compiled relay version", { versionId, relay: v.relaySlug, ms: Date.now() - t0 });
    return compiled;
  }
}

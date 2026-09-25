import "server-only";

import type { CatalogCall, SimCallResolver } from "../../core/contracts/ext/wp14b-engine";
import type { CallManifestEntry } from "../../core/contracts/scenario";
import type { AccountRecord, CallCatalog } from "../../core/contracts/v2";
import { log } from "../log";
import type { RunVersion } from "../relays/registry";

/**
 * `CallCatalog` (TASKS-v2 §5, PLATFORM §7.5 step 4): one lookup for every call a run can play.
 *
 * 1. **Generated (recorded) calls**: `src/generated/calls.json` through WP3's `CaseDataSource.getCall`. These are
 *    Baton role-plays: `simulated: false`, `relayVersionId: null` and `account: null` (the legacy `PolicyRecord` path).
 * 2. **Sims**, through WP17's `SimCallStore.resolveCall` port (`sim_calls` rows first, then the committed gallery
 *    manifest `src/generated/sim-calls.json`). DB sims carry their `relayVersionId`; a gallery sim is mapped from its
 *    relay slug + blueprint hash to the seeded gallery version with that hash (else the relay's current version),
 *    because `seedGallery()` assigns random `rv_` ids (requests/wp17-to-wp14b.md §1). The account is
 *    `version.blueprint.context.samples[sampleIndex]` (null when the version or the sample is gone).
 *
 * The resolver is read lazily (`sims()`), null until WP17's store is on main: then only step 1 answers.
 */
export interface CatalogVersionSource {
  runVersion(versionId: string): Promise<RunVersion | null>;
  galleryVersionFor(slug: string, hash: string | null): Promise<string | null>;
}

export interface RelayCallCatalogDeps {
  calls: { getCall(callId: string): Promise<CallManifestEntry | null> };
  sims: () => SimCallResolver | null;
  versions: CatalogVersionSource;
}

const catLog = log.child({ component: "call-catalog" });

export class RelayCallCatalog implements CallCatalog {
  constructor(private readonly d: RelayCallCatalogDeps) {}

  async resolve(callId: string): Promise<CatalogCall | null> {
    const recorded = await this.d.calls.getCall(callId);
    if (recorded) {
      return { ...recorded, simulated: false, relayVersionId: null, account: null, simCallId: null, sampleIndex: null, gallerySim: false };
    }
    const resolver = this.d.sims();
    if (!resolver) return null;
    const sim = await resolver.resolveCall(callId);
    if (!sim) return null;
    const relayVersionId = sim.relayVersionId ?? (sim.gallery ? await this.d.versions.galleryVersionFor(sim.relay.slug, sim.relay.blueprintHash) : null);
    let account: AccountRecord | null = null;
    if (relayVersionId) {
      const v = await this.d.versions.runVersion(relayVersionId);
      account = v?.blueprint.context.samples[sim.sampleIndex] ?? null;
      if (!account) catLog.warn("sim sample not found in its version", { callId, relayVersionId, sampleIndex: sim.sampleIndex });
    } else {
      catLog.warn("sim has no resolvable relay version", { callId, relay: sim.relay.slug });
    }
    return {
      ...sim.entry, simulated: true, relayVersionId, account, simCallId: sim.entry.callId, sampleIndex: sim.sampleIndex, gallerySim: sim.gallery,
    };
  }
}

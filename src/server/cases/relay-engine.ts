import "server-only";

import type { CaseState } from "../../core/contracts/case";
import type { CompiledRelay } from "../../core/contracts/v2";
import { accountFor } from "../../core/relay/account";
import { log } from "../log";
import type { CaseEngine } from "./engine";

/**
 * The case engine of ONE relay version (WP14b·3, PLATFORM §4.7 + §5): WP1's pure functions with the compiled
 * relay's `IntentSpec` injected, and the compiled relay's dynamic extractor in place of Baton's V3 artefacts.
 *
 * The P§4.7 widening (WP14a·4) is what makes this possible: `FieldId` is the platform id grammar, so `CaseState.fields`
 * is an open map and the spec decides which ids exist, how they normalize and which are required. WP14a·3's spec
 * injection (TASKS-v2 §2 rule 9) put the optional trailing `spec?: IntentSpec` on every core function, so this wrapper
 * adds no new core code path — it only chooses the spec.
 *
 * **The `policy` parameter carries the account.** A relay case stores an `AccountRecord` with `$kind:"account"` in
 * `cases.policy` (P§4.2, `storedAccount`), and core's `accountFor()` accepts exactly that through the unchanged
 * `PolicyRecord` parameter (`src/core/relay/account.ts`). So nothing here converts: the stored row flows straight
 * through, and the spec reads it as the account. A Baton row (a real `PolicyRecord`) still maps with `policyToAccount`,
 * which is why the flagship keeps byte-identical behaviour whether it runs with a spec or without one.
 *
 * `extractor.version` is the compiled relay's `versionId`, NOT `EXTRACTOR_VERSION_V3`. That is the point of the pin
 * (DESIGN §5.3): a relay whose fields differ has a different prompt and a different strict schema, so the WP9 `pc_ctx`
 * cache of a recorded call must not be served to it — `prefill.ts` compares the two ids and, for a relay run,
 * re-extracts the cached turns in one batched call instead (P§7.5). For the flagship compiled through the kernel the
 * generated prompt and schema are byte-identical to V3, so the id is equal and the caches keep being served.
 */
export function relayCaseEngine(base: CaseEngine, compiled: CompiledRelay): CaseEngine {
  const spec = compiled.spec;
  return {
    impl: base.impl,
    emptyCaseState: (caseId) => base.emptyCaseState(caseId, spec),
    deriveCaseState: (policy, events, ctx) => base.deriveCaseState(policy, events, ctx, spec),
    applyExtraction: (raw, turns, ctx) => base.applyExtraction(raw, turns, ctx, spec),
    verifierDisagreementEvents: (result, state, turns, ctx) => base.verifierDisagreementEvents(result, state, turns, ctx, spec),
    buildExtractorInput: (i) =>
      compiled.extractor.buildInput({
        callDate: i.callDate,
        account: accountFor(i.policy),
        state: i.state as Pick<CaseState, "fields">,
        recent: i.recent,
        newTurns: i.newTurns,
      }),
    extractor: {
      prompt: compiled.extractor.prompt,
      format: compiled.extractor.format,
      model: base.extractor.model,
      effort: base.extractor.effort,
      version: compiled.extractor.versionId,
      maxNewTurns: base.extractor.maxNewTurns,
      recentTurns: base.extractor.recentTurns,
    },
  };
}

// ============================================================================================ resolution per case

/** Resolves the case engine a case row runs on: its relay version's, or the base engine for a null `relay_version_id`. */
export type CaseEngineFor = (relayVersionId: string | null) => Promise<CaseEngine>;

/** The slice of `RelaysDeps` this needs, so `src/server/cases/**` never imports the relay graph statically. */
export interface RelayEngineSource {
  engine: { forVersion(versionId: string | null): Promise<CompiledRelay> };
}

const relayEngineLog = log.child({ component: "relay-case-engine" });

/**
 * The default resolver: the compiled relay from WP14b's `RelayEngineFactory` (its own LRU 50), wrapped once per
 * compiled object (a `WeakMap`, so an evicted compile is collected with its wrapper). `null` — a Baton case, and every
 * case on a server with no kernel — is the base engine, unchanged.
 *
 * A version that cannot be compiled (no kernel bound, a deleted version, a lint error) falls back to the base engine
 * with a warning rather than failing the read: a case row outlives its relay version, and a transcript must still
 * load. Runs never reach that fallback — `POST /api/cases` compiles the version before it writes the row.
 */
export function defaultEngineFor(base: CaseEngine, relays: () => Promise<RelayEngineSource>): CaseEngineFor {
  const cache = new WeakMap<CompiledRelay, CaseEngine>();
  return async (relayVersionId) => {
    if (!relayVersionId) return base;
    try {
      const compiled = await (await relays()).engine.forVersion(relayVersionId);
      const hit = cache.get(compiled);
      if (hit) return hit;
      const wrapped = relayCaseEngine(base, compiled);
      cache.set(compiled, wrapped);
      return wrapped;
    } catch (err) {
      relayEngineLog.warn("relay version does not compile; falling back to the base engine", { relayVersionId, err });
      return base;
    }
  };
}

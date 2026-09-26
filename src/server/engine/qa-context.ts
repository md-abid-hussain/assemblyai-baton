import "server-only";

import { STAGES } from "../../core/contracts/case";
import type { CompiledRelay } from "../../core/contracts/v2";
import { log } from "../log";
import type { RelayQaContext } from "../qa/build-input";
import type { RelayRunDeps } from "./run";

/**
 * The relay half of the QA input (WP14b·3, TASKS-v2 WP14b acceptance 6, PLATFORM §4.1).
 *
 * `buildQaInput` (`src/server/qa/build-input.ts`) is written against Baton's three hard-coded sets: the six built-in
 * tool names, `KEYTERM_FIELDS`, and the two `DisclosureKind`s. Each of those is a *relay* fact, so each one is read
 * off `CompiledRelay` here and passed in. **Omit the context and every output is Baton's, byte for byte** — that is
 * the fallback the verify job takes for a plain Baton takeover, and it is what keeps WP8's corpus green.
 *
 * Why this file and not `build-input.ts`: `build-input.ts` must stay importable by WP8's pure QA tests, which have no
 * kernel, no registry and no `server-only`. The engine dependency lives on this side of the seam.
 */

const qaLog = log.child({ component: "relay-qa-context" });

/**
 * The QA context of a compiled relay, or **null for the legacy Baton engine** (`blueprint === null`, which is what
 * `forVersion(null)` returns). A null answer is not a failure: it means "use Baton's constants", which for the
 * flagship is the right answer and the parity target — `buildIntentSpec(batonBlueprint)` must reproduce them
 * (P§4.6), so a flagship run must not be scored against a *different* set of sets than WP8's corpus was.
 */
export function relayQaContext(compiled: CompiledRelay): RelayQaContext | null {
  if (!compiled.blueprint) return null;
  const toolNames = new Set<string>();
  for (const stage of STAGES) for (const t of compiled.tools(stage)) toolNames.add(t.name);
  return {
    spec: compiled.spec,
    toolNames,
    // Blueprint order, which is the order `disclosuresOf` emits and the order the console renders (P§7.6).
    disclosureIds: compiled.ui.disclosures.map((d) => d.id),
  };
}

/**
 * The context for one case, by its `cases.relay_version_id`. Null for a Baton case (no version id), when no relay
 * graph is wired, and — deliberately — when the compile fails.
 *
 * A compile failure here must never fail the verification: QA runs *after* the call, on a pass that already happened,
 * so the worst a missing context can do is score a relay run with Baton's sets. Losing the whole QA result instead
 * would be strictly worse, and the reason is logged. (The *run* path is the opposite: `relayTakeoverCompile` throws,
 * because there a wrong prompt reaches a live caller.)
 */
export async function relayQaContextFor(
  relays: (() => RelayRunDeps | null) | null | undefined,
  relayVersionId: string | null | undefined,
): Promise<RelayQaContext | null> {
  if (!relayVersionId) return null;
  const d = relays?.();
  if (!d) return null;
  try {
    return relayQaContext(await d.engine.forVersion(relayVersionId));
  } catch (err) {
    qaLog.warn("could not compile a relay version for QA; scoring with Baton's sets", { relayVersionId, err });
    return null;
  }
}

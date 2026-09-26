import "server-only";

import { RELAY_ENGINES, type RelayEngineMode } from "../../core/contracts/v2";
import { log } from "../log";

/**
 * `RELAY_ENGINE` (PLATFORM §4.6 "Runtime switch"), WP14b·3.
 *
 * - **`legacy`** — the default, **and the submission setting** (P§0 P3): a Baton case keeps `relay_version_id = null`
 *   and runs WP1's functions with no spec, exactly as it does today. Generic relays are unaffected: they always run
 *   on the kernel, because their `relay_version_id` is what makes them exist at all.
 * - **`kernel`** — a plain Baton run is pinned to the seeded flagship version, so every engine call goes through
 *   `compiled.spec`. It is implemented and tested with fake upstreams only; it is **not scheduled for Zerops**
 *   (v2.1, P§13 X14), and the parity suite (P§4.6) is its gate.
 *
 * The slug of the flagship relay this pins to is `FLAGSHIP_SLUG`, seeded from `FLAGSHIP_FILES[0]`.
 *
 * `RELAY_ENGINE` is read from `process.env` rather than `EnvSchema`, because `src/server/env.ts` is WP12's file
 * (TASKS-v2 §4). The request to add it is `docs/notes/requests/wp14b-to-wp12.md`; until then an unknown value logs
 * once and falls back to `legacy` — a typo must never silently move the flagship onto unproven code.
 */
export const FLAGSHIP_SLUG = "baton-add-driver";

const modeLog = log.child({ component: "relay-engine-mode" });
let warned = false;

export function relayEngineMode(): RelayEngineMode {
  const raw = (process.env.RELAY_ENGINE ?? "").trim();
  if (!raw) return "legacy";
  if ((RELAY_ENGINES as readonly string[]).includes(raw)) return raw as RelayEngineMode;
  if (!warned) {
    warned = true;
    modeLog.warn("unknown RELAY_ENGINE value; using legacy", { got: raw, expected: RELAY_ENGINES });
  }
  return "legacy";
}

/** Tests only: forget the "unknown value" latch so a second bad value warns again. */
export function resetRelayEngineModeWarning(): void {
  warned = false;
}

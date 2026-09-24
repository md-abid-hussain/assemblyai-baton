import "server-only";

import type { CaseEngine } from "./engine";
import { stubEngine } from "./engine-stub";
import type { CasesPlatform } from "./platform";
import { createStubPlatform } from "./platform-stub";

/**
 * THE ONE FILE THE INTEGRATOR SWAPS AT G1 (docs/notes/requests/wp3-to-integrator.md has the exact replacement):
 * - `defaultEngine()` → WP1's `src/core/case` functions (`impl: "wp1"`);
 * - `defaultPlatform()` → WP2's `src/server/auth` + `src/server/limits` (DB rate limiter, spend ledger).
 * Before G1 both are WP3's stand-ins, so this worktree builds and its tests run without wp/wp1 and wp/wp2.
 */
export function defaultEngine(): CaseEngine {
  return stubEngine;
}

export function defaultPlatform(): CasesPlatform {
  return createStubPlatform();
}

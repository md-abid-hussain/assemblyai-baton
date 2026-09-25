/**
 * remote.ts - the `LIMITS_ROLE=remote` client for Node scripts and live tests (G1; answers wp0b-to-wp2 item 2).
 *
 * WP2's `RemoteLimitsAuthority` (route #28 over HTTP, `x-limits-key`) with the split-budget fallback of DESIGN §2.3:
 * when the Zerops authority is unreachable (network error, timeout, 5xx) a call goes to a laptop file guard limited
 * to 2 STT opens/min and 1 VA session. 4xx answers never fall back.
 *
 * `scripts/lib/limits.ts` imports this module, so every script that calls `getLimitsAuthority()` can run remotely.
 * Like every path to `src/server/**`, it needs `tsx --conditions=react-server` (all `npm run` scripts use it):
 * `remote-authority.ts` starts with `import "server-only"`. No cycle: this file does not import `./limits`.
 * Never logs the key.
 */
import type { LimitsAuthority } from "../../src/core/contracts/services";
import { RemoteLimitsAuthority } from "../../src/server/limits/remote-authority";
import { LocalOpenGuard } from "./local-open-guard";

/** The split budget used while the authority is unreachable (DESIGN §2.3). */
export const REMOTE_FALLBACK_BUDGET = { sttOpensPerMin: 2, vaMax: 1 } as const;

export function createRemoteLimitsAuthority(url: string, key: string): LimitsAuthority {
  return new RemoteLimitsAuthority(url, key, { fallback: new LocalOpenGuard({ ...REMOTE_FALLBACK_BUDGET }) });
}

import "server-only";

import type { KernelBinding } from "../../core/contracts/ext/wp14b-engine";
import { KERNEL_VERSION } from "../../core/contracts/v2";
import { policyToAccount } from "../../core/relay/account";
import { cannedCaseState } from "../../core/relay/canned";
import { compileRelay } from "../../core/relay/compile";

/**
 * The ONE place WP14a's kernel is bound into the server (TASKS-v2 §2: never import another WP's unmerged code).
 *
 * **Bound at G2-finish**, now that WP14a·2/·3 (`compile.ts`, `account.ts`, `canned.ts`) are on `main`; this constant
 * and `src/server/relays/kernel.ts` are the whole swap (docs/notes/wp14b.md "What the integrator must do" §2).
 * `cannedSnapshot` is WP14a's `cannedCaseState`, whose 4th `caseId` parameter is optional
 * (docs/notes/requests/wp14a-to-wp14b.md §3).
 *
 * With a null binding — which is what tests get when they pass `null`, and what shipped before this commit —
 * `RelayEngineFactory.forVersion` and `GET /api/relays/:id/compiled` answer 503 E_MAINTENANCE, `/api/cases` with a
 * `relayId`/`relayVersionId` answers 503 after access and moderation checks, and Baton runs keep their v1 response
 * (the v2 fields are added only when the binding is set). Tests bind a fake with `setKernelBinding`.
 */
const DEFAULT_BINDING: KernelBinding | null = {
  kernelVersion: KERNEL_VERSION,
  compile: (bp, o) => compileRelay(bp, o),
  policyToAccount: (p) => policyToAccount(p),
  cannedSnapshot: (compiled, account, state) => cannedCaseState(compiled, account, state),
};

type Holder = { binding: KernelBinding | null; set: boolean };
const g = globalThis as typeof globalThis & { __changeoverKernel?: Holder };
const holder: Holder = (g.__changeoverKernel ??= { binding: null, set: false });

export function getKernelBinding(): KernelBinding | null {
  return holder.set ? holder.binding : DEFAULT_BINDING;
}

/** Tests and scripts: bind a kernel (a fake, or the real one before it is the default); `undefined` restores the default. */
export function setKernelBinding(b: KernelBinding | null | undefined): void {
  if (b === undefined) {
    holder.set = false;
    holder.binding = null;
    return;
  }
  holder.set = true;
  holder.binding = b;
}

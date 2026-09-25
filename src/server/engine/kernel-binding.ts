import "server-only";

import type { KernelBinding } from "../../core/contracts/ext/wp14b-engine";

/**
 * The ONE place WP14a's kernel is bound into the server (TASKS-v2 §2: never import another WP's unmerged code).
 *
 * `src/core/relay/{compile,account}.ts` are WP14a·2 and not on main yet, so the default binding is null. Once they
 * are (`git merge main`), the swap is this constant only:
 *
 *   import { KERNEL_VERSION } from "../../core/contracts/v2";
 *   import { compileRelay } from "../../core/relay/compile";
 *   import { policyToAccount } from "../../core/relay/account";
 *   import { cannedSnapshot } from "../../core/relay/<lint G2 canned states>";   // WP14a·3
 *   const DEFAULT_BINDING: KernelBinding | null = { kernelVersion: KERNEL_VERSION, compile: (bp, o) => compileRelay(bp, o),
 *     policyToAccount: (p) => policyToAccount(p), cannedSnapshot };
 *
 * together with `src/server/relays/kernel.ts` (`lintBlueprintJson` + `blueprintHash`). With a null binding:
 * `RelayEngineFactory.forVersion` and `GET /api/relays/:id/compiled` answer 503 E_MAINTENANCE, `/api/cases` with a
 * `relayId`/`relayVersionId` answers 503 after access and moderation checks, and Baton runs keep their v1 response
 * (the v2 fields are added only when the binding is set). Tests bind a fake with `setKernelBinding`.
 */
const DEFAULT_BINDING: KernelBinding | null = null;

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

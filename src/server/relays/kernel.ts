import "server-only";

import { KERNEL_VERSION, type Blueprint, type LintIssue } from "../../core/contracts/v2";
import { lintBlueprintJson } from "../../core/relay/lint";
import { BlueprintMigrationError, blueprintHash, migrateBlueprint } from "../../core/relay/migrate";

/**
 * The slice of WP14a's kernel the registry needs, as a port (TASKS-v2 §2: never import another WP's unmerged code).
 *
 * `parse` = WP14a's `migrateBlueprint` + `lintBlueprintJson(json)` (`BlueprintSchema` + the full rule lint), `hash` =
 * WP14a's isomorphic `blueprintHash`. **Swapped in at G2-finish** (WP14a·2/·3 are on `main`; before that this file
 * parsed with `BlueprintSchema` and reported `SCHEMA` issues only). The core and server hashes are identical —
 * `./canonical.ts` stays as the server-side definition and the pinned vector in `tests/unit/server/relays/pure.test.ts`
 * covers both (docs/notes/requests/wp14b-to-wp14a.md §1).
 *
 * `parse` must never throw: `migrateBlueprint` rejects a non-object or an unknown `meta.schema`, so that becomes a
 * `SCHEMA` issue with a null blueprint, exactly as a zod failure does.
 */
export interface RelayKernel {
  readonly kernelVersion: string;
  /** Parse + lint any JSON. `blueprint` is null when it fails `BlueprintSchema` (then `issues` explain why). */
  parse(json: unknown): { blueprint: Blueprint | null; issues: LintIssue[] };
  /** Content address of a parsed blueprint. */
  hash(bp: Blueprint): string;
}

export const hasLintErrors = (issues: readonly LintIssue[]): boolean => issues.some((i) => i.severity === "error");

export const defaultRelayKernel: RelayKernel = {
  kernelVersion: KERNEL_VERSION,
  parse(json) {
    let migrated: unknown;
    try {
      migrated = migrateBlueprint(json);
    } catch (e) {
      if (!(e instanceof BlueprintMigrationError)) throw e;
      return { blueprint: null, issues: [{ code: "SCHEMA", severity: "error", path: [], message: e.message }] };
    }
    return lintBlueprintJson(migrated);
  },
  hash: (bp) => blueprintHash(bp),
};

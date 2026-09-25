import "server-only";

import { BlueprintSchema, KERNEL_VERSION, type Blueprint, type LintIssue } from "../../core/contracts/v2";
import { blueprintHash } from "./canonical";

/**
 * The slice of WP14a's kernel the registry needs, as a port (TASKS-v2 §2: never import another WP's unmerged code).
 *
 * `parse` = WP14a's `lintBlueprintJson(json)` (`migrateBlueprint` + `BlueprintSchema` + `lintBlueprint`), `hash` =
 * `blueprintHash`. Until WP14a·2 lands on main, `defaultRelayKernel` parses with `BlueprintSchema` and maps zod issues
 * to `SCHEMA` lint issues only (no rule lint). The swap is this file only:
 *   parse: (json) => lintBlueprintJson(json), hash: (bp) => blueprintHash(bp)   // from src/core/relay/{lint,migrate}
 * (docs/notes/wp14b.md "What the integrator must do").
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
    const r = BlueprintSchema.safeParse(json);
    if (r.success) return { blueprint: r.data, issues: [] };
    return {
      blueprint: null,
      issues: r.error.issues.slice(0, 50).map((iss) => ({
        code: "SCHEMA",
        severity: "error" as const,
        path: iss.path.filter((k): k is string | number => typeof k !== "symbol"),
        message: iss.message,
      })),
    };
  },
  hash: (bp) => blueprintHash(bp),
};

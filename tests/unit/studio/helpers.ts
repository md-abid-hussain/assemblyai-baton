/**
 * Shared fixture for the Configure and Overview tests.
 *
 * Both tabs are models over a *real* blueprint, so the tests run against the committed Dental example rather than
 * a hand-built object: it is the relay TASKS-v3 §7 acceptance 1 names ("clone Dental → edit a field in Configure
 * → the Code tab shows the change with the YAML comments intact"), and a hand-built blueprint would quietly stop
 * resembling one the moment the contract moved.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Edit } from "@/client/studio/configure";
import type { Blueprint } from "@/core/contracts/v2";
import { applyEdit, validateSource, type SourceFormat } from "@/core/relay-code";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

export const DENTAL_YAML: string = readFileSync(`${ROOT}/examples/relays/dental-deposit.yaml`, "utf8");

/**
 * The example with comments added above three of the blocks a form edit touches.
 *
 * `applyEdit` claims to keep the author's comments; a fixture with only the schema header at the top could not
 * tell a codec that keeps them from one that rewrites the file and happens to re-emit the first line.
 */
export function commentedDental(): string {
  return DENTAL_YAML.replace(/^fields:$/m, "# --- the case fields ---\nfields:")
    .replace(/^handoff:$/m, "# --- where the baton changes hands ---\nhandoff:")
    .replace(/^connectors:$/m, "# --- what it can actually do ---\nconnectors:");
}

export function parse(text: string): Blueprint {
  const { blueprint } = validateSource(text);
  if (!blueprint) {
    const first = validateSource(text).diagnostics.find((d) => d.severity === "error");
    throw new Error(`the fixture no longer validates: ${first?.code} ${first?.message}`);
  }
  return blueprint;
}

/** What `applyFormEdits` does to the text: each edit against the result of the one before it. */
export function applyAll(text: string, edits: readonly Edit[], format: SourceFormat = "yaml"): string {
  let out = text;
  for (const e of edits) out = applyEdit(out, format, e.path, e.value);
  return out;
}

/** Apply and re-validate in one step, which is the assertion most of these tests actually want. */
export function applyAndParse(text: string, edits: readonly Edit[]): { text: string; blueprint: Blueprint } {
  const next = applyAll(text, edits);
  return { text: next, blueprint: parse(next) };
}

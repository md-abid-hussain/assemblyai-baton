/**
 * PLATFORM §4.6 corpus item "WP8's QA fixtures": the verification pipeline's fixture call (WP8's multichannel
 * transcript, VA timeline and snapshot builders in tests/unit/server/verify/helpers.ts) goes through WP8's
 * `buildQaInput` and then `computeQa` with no spec, with `LEGACY_BATON_SPEC` and with the compiled Baton spec:
 * all three results are equal, over snapshot variants that make the fixture's ZIP question a re-ask, a confirm or a
 * first ask, and over WP1's QA disclosure texts.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CaseState, FieldId } from "@/core/contracts";
import { BlueprintSchema, type IntentSpec } from "@/core/contracts/v2";
import { disclosureText } from "@/core/compiler/disclosures";
import { LEGACY_BATON_SPEC } from "@/core/intents/baton-legacy-spec";
import { computeQa, type QaInput } from "@/core/qa";
import { compileRelay } from "@/core/relay/compile";
import { buildQaInput } from "@/server/qa/build-input";
import { field, POLICY, snapshot, TIMELINE_FIXTURE, transcriptFixture } from "../../server/verify/helpers";

const bp = BlueprintSchema.parse(JSON.parse(readFileSync(join(process.cwd(), "data", "relays", "baton-add-driver.json"), "utf8")));
const compiled = compileRelay(bp, { flagship: true });
const SPECS: [string, IntentSpec | undefined][] = [["legacy", LEGACY_BATON_SPEC], ["compiled", compiled.spec]];

const same = (input: QaInput): void => {
  const want = computeQa(input);
  for (const [name, spec] of SPECS) expect({ spec: name, got: computeQa(input, spec) }).toEqual({ spec: name, got: want });
};

const variants: [string, CaseState][] = [
  ["nothing known", snapshot()],
  ["ZIP verified (the question is a re-ask)", snapshot({ garaging_zip: field("garaging_zip", "VERIFIED", "78701") })],
  ["ZIP pending (the question confirms)", snapshot({ garaging_zip: field("garaging_zip", "PENDING", "78701") })],
  ["name and vehicle verified", snapshot({
    driver_full_name: field("driver_full_name", "VERIFIED", "lucas delgado", "Lucas Delgado"),
    vehicle_assignment: field("vehicle_assignment", "VERIFIED", "veh1", "2014 Toyota Corolla"),
  } as Partial<Record<FieldId, ReturnType<typeof field>>>)],
];

describe("parity: WP8's QA fixture call through buildQaInput → computeQa", () => {
  for (const [name, snap] of variants) {
    it(name, () => {
      for (const outcome of ["completed", "handed_back"] as const) {
        const premium = disclosureText("premium_change", { snapshot: snap, policy: POLICY, monthlyUsd: "171.00", dueTodayUsd: "29.00" });
        const input = buildQaInput({
          snapshot: snap, policy: POLICY, transcript: transcriptFixture("t1"), timeline: TIMELINE_FIXTURE,
          greeting: "Hi Mark, I'm Daniel's AI assistant, not a person. This call is recorded.", outcome,
          metrics: { disclosures: { premium_change: { text: premium.text, criticalTokens: premium.criticalTokens } } },
          payment: null, durationSec: 62.5,
        }) as unknown as QaInput;
        same(input);
        same({ ...input, provisional: true });
      }
    });
  }
});

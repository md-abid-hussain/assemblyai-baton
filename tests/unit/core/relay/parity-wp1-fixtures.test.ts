/**
 * PLATFORM §4.6 corpus item "WP1's compiler fixtures": the committed first `session.update` fixtures of WP1's
 * compiler (tests/unit/core/compiler/__fixtures__/first-update-{confirm,disclose}.{s01,s02}.json, deployId
 * "dev-wp1", keyterms off) are reproduced byte-for-byte by the kernel compile of data/relays/baton-add-driver.json
 * (flagship), from the same WP1 handoff states.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BlueprintSchema } from "@/core/contracts/v2";
import { buildFirstUpdate } from "@/core/compiler/first-update";
import { policyToAccount } from "@/core/relay/account";
import { compileRelay } from "@/core/relay/compile";
import { handoffStateOf, policyOf } from "../case/_fixtures";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const FIXTURES = join(ROOT, "tests", "unit", "core", "compiler", "__fixtures__");
const bp = BlueprintSchema.parse(JSON.parse(readFileSync(join(ROOT, "data", "relays", "baton-add-driver.json"), "utf8")));
const kernel = compileRelay(bp, { flagship: true });

describe("parity: WP1's committed first-update fixtures", () => {
  for (const id of ["s01", "s02"] as const) {
    for (const stage of ["confirm", "disclose"] as const) {
      it(`${id} · ${stage}`, () => {
        const want = readFileSync(join(FIXTURES, `first-update-${stage}.${id}.json`), "utf8");
        const c = kernel.takeover(handoffStateOf(id), policyToAccount(policyOf(id)), { deployId: "dev-wp1", stage });
        expect(`${JSON.stringify(buildFirstUpdate(c), null, 2)}\n`).toBe(want);
      });
    }
  }
});

/**
 * The browser compile (P§7.3, TASKS-v3 §7 acceptance 2: "the client and server hashes are equal").
 *
 * The point of these tests is the *agreement* between the two compiles, not the contents of either: the Studio shows
 * a banner when they differ, and a banner that fires on every edit would be worse than no banner. So the browser
 * preview is compared field by field with `src/server/engine/compile-view.ts`, which is what `GET
 * /api/relays/:id/compiled` returns.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { compilePreview, greetingFor, PREVIEW_STATE } from "@/client/studio/preview";
import { CANNED_STATES, KERNEL_VERSION, type Blueprint } from "@/core/contracts/v2";
import { cannedCaseState } from "@/core/relay/canned";
import { compileRelay } from "@/core/relay/compile";
import { blueprintHash } from "@/core/relay/migrate";
import { validateSource } from "@/core/relay-code";
import { compiledRelayView } from "@/server/engine/compile-view";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const BATON_YAML = readFileSync(`${ROOT}/examples/relays/baton-add-driver.yaml`, "utf8");

function blueprint(): Blueprint {
  const { blueprint: bp } = validateSource(BATON_YAML);
  if (!bp) throw new Error("the committed Baton example no longer validates");
  return bp;
}

describe("compilePreview", () => {
  it("hashes identically to the canonical blueprint hash the server uses", () => {
    const bp = blueprint();
    expect(compilePreview(bp).hash).toBe(blueprintHash(bp));
  });

  it("renders every sample × the four canned states", () => {
    const bp = blueprint();
    const preview = compilePreview(bp);
    expect(preview.greetings).toHaveLength(bp.context.samples.length * CANNED_STATES.length);
    const g = greetingFor(preview, "all_verified");
    expect(g).not.toBeNull();
    expect(g!.text.length).toBeGreaterThan(0);
    expect(g!.wordCount).toBeGreaterThan(0);
    expect(g!.estSeconds).toBeGreaterThan(0);
  });

  it("produces a strict extractor schema and a valid first update", () => {
    const preview = compilePreview(blueprint(), { flagship: true });
    expect(preview.extractor.strictOk).toBe(true);
    expect(preview.extractor.strictReason).toBeNull();
    expect(preview.firstUpdate.ok).toBe(true);
    expect(preview.kernelVersion).toBe(KERNEL_VERSION);
  });

  it("agrees with the server's compiled view, field for field", () => {
    const bp = blueprint();
    const compiled = compileRelay(bp, { flagship: false });
    const server = compiledRelayView({
      relayId: "rl_x",
      versionId: null,
      blueprint: bp,
      lint: [],
      compiled,
      binding: { kernelVersion: KERNEL_VERSION, cannedSnapshot: (c, account, state) => cannedCaseState(c, account, state) },
      // The one field that legitimately differs: the browser has no deploy id, so it stamps "preview".
      deployId: "preview",
    });
    const browser = compilePreview(bp);

    expect(browser.hash).toBe(server.hash);
    expect(browser.greetings).toEqual(server.greetings);
    expect(browser.prompts).toEqual(server.prompts);
    expect(browser.tools).toEqual(server.tools);
    expect(browser.listening).toEqual(server.listening);
    expect(browser.firstUpdate).toEqual(server.firstUpdate);
    expect(browser.extractor.schema).toEqual(server.extractor.schema);
    expect(browser.extractor.strictOk).toBe(server.extractor.strictOk);
    expect(browser.ui).toEqual(server.ui);
  });

  it("shows the prompt for the state a pass usually happens in", () => {
    expect(PREVIEW_STATE).toBe("one_pending");
    const preview = compilePreview(blueprint());
    expect(preview.prompts.every((p) => p.chars > 0)).toBe(true);
  });
});

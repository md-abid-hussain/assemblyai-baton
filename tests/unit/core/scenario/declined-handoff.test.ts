/**
 * The declined hand-off, pinned against the real STT finals that were cached for it (WP9·3).
 *
 * `s03` is the only take where the customer refuses the hand-off, so it is the fixture that proves auto-baton can
 * *decline*. It also carries a trap worth keeping visible: a streaming final arrives several hundred ms after the
 * speech it describes, so the customer's answer to the PREVIOUS question ("That's fine.") arrives while the rep's
 * hand-off line is still playing. Matching acceptance by arrival time reads that as consent and batons a call the
 * customer said no to; matching by word timestamps does not. These tests fail if that ordering ever stops holding,
 * or if someone "fixes" the labels to make the declined take look accepted.
 *
 * Generated-speech caveat: this pins string handling and ordering, never timing thresholds.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { safeTest } from "../../../../src/core/contracts/v2/regex";
import { type CallManifestEntry } from "../../../../src/core/contracts/scenario";
import { REPO_ROOT } from "../../../../scripts/calls/lib/kit-io";

interface SttWord {
  start: number;
  end: number;
  text: string;
}
interface SttRecord {
  channel: string;
  recvMs: number;
  message: { end_of_turn?: boolean; turn_is_formatted?: boolean; transcript?: string; words?: SttWord[] };
}

const calls = JSON.parse(readFileSync(join(REPO_ROOT, "src", "generated", "calls.json"), "utf8")) as CallManifestEntry[];
const declined = calls.find((c) => c.handoff?.declined === true);
const cachePath = declined ? join(REPO_ROOT, "data", "cache", "stt", declined.callId, "pc_ctx.jsonl") : "";
const haveCache = declined !== undefined && existsSync(cachePath);

/** The formatted customer finals, in arrival order, with the span of the speech they describe. */
function customerFinals(): Array<{ recvMs: number; wordsEnd: number; transcript: string }> {
  return readFileSync(cachePath, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as SttRecord)
    .filter((r) => r.channel === "customer" && r.message.end_of_turn === true && r.message.turn_is_formatted === true)
    .filter((r) => (r.message.words ?? []).length > 0)
    .map((r) => ({
      recvMs: r.recvMs,
      wordsEnd: r.message.words![r.message.words!.length - 1]!.end,
      transcript: r.message.transcript ?? "",
    }));
}

const acceptancePatterns = (
  JSON.parse(readFileSync(join(REPO_ROOT, "data", "relays", "baton-add-driver.json"), "utf8")) as {
    handoff: { acceptance: { patterns: string[] } };
  }
).handoff.acceptance.patterns;

const accepts = (text: string): boolean => acceptancePatterns.some((p) => safeTest(p, text));

describe("the declined hand-off take", () => {
  it("exists in the committed manifest, with its STT cache", () => {
    expect(declined, "no declined take in calls.json").toBeDefined();
    expect(haveCache, `missing ${cachePath}`).toBe(true);
  });

  it.skipIf(!haveCache)("the customer's reply after the rep line is a refusal, not an acceptance", () => {
    const { lineStartMs } = declined!.handoff!;
    // The reply is the first final whose SPEECH begins after the line started.
    const reply = customerFinals().find((f) => f.wordsEnd >= lineStartMs);
    expect(reply, "no customer final after the hand-off line").toBeDefined();
    expect(accepts(reply!.transcript), `"${reply!.transcript}" must not read as acceptance`).toBe(false);
  });

  it.skipIf(!haveCache)("matching by ARRIVAL time instead of word timestamps would false-accept this call", () => {
    const { lineStartMs } = declined!.handoff!;
    const finals = customerFinals();
    // The trap: a final that ARRIVED after the line started, but whose words ended before it.
    const stale = finals.filter((f) => f.recvMs >= lineStartMs && f.wordsEnd < lineStartMs);
    expect(stale.length, "the arrival-vs-words gap this test guards has disappeared").toBeGreaterThan(0);
    expect(stale.some((f) => accepts(f.transcript)), "expected a stale final that matches acceptance").toBe(true);
    // ...and the correct rule skips every one of them.
    for (const f of stale) expect(f.wordsEnd).toBeLessThan(lineStartMs);
  });

  it.skipIf(!haveCache)("the take carries no acceptance label, and its tail starts where the line ends", () => {
    const labels = JSON.parse(readFileSync(join(REPO_ROOT, "data", "labels", `${declined!.callId}.json`), "utf8")) as {
      handoff: { lineEndMs: number; acceptStartMs: number | null };
      tailStartsMs: number | null;
      reviewed: boolean;
    };
    expect(labels.handoff.acceptStartMs).toBeNull();
    expect(labels.tailStartsMs).toBe(labels.handoff.lineEndMs);
    expect(labels.reviewed, "a generated take is never a reviewed ground truth").toBe(false);
  });
});

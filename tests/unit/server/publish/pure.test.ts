/**
 * WP18·1, the pure half: the published config compiler (PLATFORM §8.1 step 2, §6.6), the publication key, and the
 * helpers the gateway and the one state route are built on. No DB, no network, $0.
 */
import { describe, expect, it } from "vitest";

import { compileRelay } from "@/core/relay/compile";
import type { AccountRecord, Blueprint } from "@/core/contracts/v2";
import {
  firstStage, httpToolFor, publishedAgentDefinition, publishedSystemPrompt, publishedToolList, PUBLISHED_NEXT_STEP_RULE,
  redactPublishedConfig, runtimeStages, withPublishedRules,
} from "@/server/publish/config";
import { argsHashOf } from "@/server/publish/gateway";
import { hashPublicationKey, newPublicationKey, publicationKeyMatches, shareSlugFor } from "@/server/publish/keys";
import { eventsFrom, stageSeqOf } from "@/server/publish/state";
import { miniBlueprint } from "../../core/relay/fixtures/mini-blueprint";

const bp: Blueprint = miniBlueprint();
const compiled = compileRelay(bp, { relayId: "rl_test", versionId: "rv_test", hash: "h", flagship: false });
const account = bp.context.samples[0] as AccountRecord;
const KEY = "a".repeat(64);
const target = { appUrl: "https://changeover.example", publicationId: "pub_abc", key: KEY };

describe("published config", () => {
  it("keeps the deploy marker last and puts the published rules in front of it", () => {
    const prompt = withPublishedRules("body text\n\n(internal ref: baton-deploy=dev-x; never mention this)");
    expect(prompt.endsWith("(internal ref: baton-deploy=dev-x; never mention this)")).toBe(true);
    expect(prompt).toContain(PUBLISHED_NEXT_STEP_RULE);
    expect(prompt.indexOf(PUBLISHED_NEXT_STEP_RULE)).toBeLessThan(prompt.indexOf("(internal ref:"));
  });

  it("appends the rules when there is no marker line", () => {
    expect(withPublishedRules("body text").trim().endsWith(PUBLISHED_NEXT_STEP_RULE)).toBe(true);
  });

  it("compiles the first stage with an empty case, the in-band rule and the marker (docs/notes/wp18.md decision 2)", () => {
    const stage = firstStage(bp);
    expect(stage).toBe(runtimeStages(bp)[0]);
    const prompt = publishedSystemPrompt({ compiled, account, stage, deployId: "dev-x" });
    expect(prompt).toContain(PUBLISHED_NEXT_STEP_RULE);
    expect(prompt).toContain("baton-deploy=dev-x");
    // an empty case: no field VALUES are baked into the stored prompt
    expect(prompt).not.toContain("Jordan");
  });

  it("lists every tool of every stage once, in first-seen order", () => {
    const names = publishedToolList(compiled, bp).map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    const declared = new Set(bp.playbook.stages.flatMap((s) => s.tools));
    for (const n of names) expect(declared.has(n)).toBe(true);
    expect(names).toContain("send_deposit_link");
    expect(names).toContain("send_confirmation");
  });

  it("maps a tool to the T4 HTTP shape: POST, the gateway URL, the key header", () => {
    const tool = publishedToolList(compiled, bp)[0]!;
    const http = httpToolFor(tool, target);
    expect(http.http.http_method).toBe("POST");
    expect(http.http.url).toBe(`https://changeover.example/api/connectors/pub/pub_abc/${tool.name}`);
    expect(http.http.headers).toEqual([{ name: "X-Changeover-Key", value: KEY }]);
    expect(http.execution_mode).toBe("interactive");
    expect(http.timeout_seconds).toBeGreaterThan(0);
  });

  it("the agent definition listens first, uses the playbook voice and the balanced input mode", () => {
    const def = publishedAgentDefinition({ compiled, blueprint: bp, deployId: "dev-x", target, name: "changeover-x-v1" });
    expect("greeting" in def).toBe(false);
    expect(def.voice).toEqual({ voice_id: bp.playbook.voice });
    expect(def.input).toEqual({ transcription_mode: "balanced" });
    expect(def.tools?.length).toBe(publishedToolList(compiled, bp).length);
    expect(def.name).toBe("changeover-x-v1");
  });

  it("the redacted config keeps the header NAME and no value, and never carries the key", () => {
    const def = publishedAgentDefinition({ compiled, blueprint: bp, deployId: "dev-x", target });
    const redacted = redactPublishedConfig(def);
    const json = JSON.stringify(redacted);
    expect(json).not.toContain(KEY);
    expect(json).toContain("X-Changeover-Key");
    const tools = redacted.tools as { http: { headers: { name: string; value?: string }[] } }[];
    for (const t of tools) for (const h of t.http.headers) expect(h.value).toBeUndefined();
    // the original definition is untouched
    expect((def.tools![0] as { http: { headers: { value?: string }[] } }).http.headers[0]!.value).toBe(KEY);
  });
});

describe("the publication key", () => {
  it("is 32 random bytes, stored only as a hash, and compared constant-time", () => {
    const key = newPublicationKey();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    const hash = hashPublicationKey(key);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toBe(key);
    expect(publicationKeyMatches(key, hash)).toBe(true);
    // one character different, whatever the last character happens to be
    expect(publicationKeyMatches(`${key.slice(0, 63)}${key.endsWith("0") ? "1" : "0"}`, hash)).toBe(false);
    expect(publicationKeyMatches("", hash)).toBe(false);
    expect(publicationKeyMatches(null, hash)).toBe(false);
    expect(publicationKeyMatches(key, "")).toBe(false);
    expect(newPublicationKey()).not.toBe(key);
  });

  it("builds a share slug from the relay slug", () => {
    expect(shareSlugFor("Dental Deposit!", "ab12cd")).toBe("dental-deposit-ab12cd");
    expect(shareSlugFor("", "ab12cd")).toBe("relay-ab12cd");
  });
});

describe("gateway and state helpers", () => {
  it("hashes args canonically: key order does not change the dedupe key, values do", () => {
    expect(argsHashOf({ a: 1, b: "x" })).toBe(argsHashOf({ b: "x", a: 1 }));
    expect(argsHashOf({ a: 1 })).not.toBe(argsHashOf({ a: 2 }));
    expect(argsHashOf({})).toBe(argsHashOf(null));
  });

  it("stageSeq is the forward-only stage index", () => {
    const stages = runtimeStages(bp);
    expect(stageSeqOf(bp, null)).toBe(0);
    expect(stageSeqOf(bp, stages[0]!)).toBe(0);
    expect(stageSeqOf(bp, stages[stages.length - 1]!)).toBe(stages.length - 1);
    expect(stageSeqOf(bp, "nonsense" as never)).toBe(0);
  });

  it("events are numbered from 1 and filtered by the cursor", () => {
    const at = new Date("2026-09-25T12:00:00.000Z");
    const rows = [
      { createdAt: at, toolName: "send_deposit_link", status: "ok", result: { body: { status: "link_sent" }, stage: "pay", nextStep: "Send the confirmation.", ui: { sms: "pay here" } } },
      { createdAt: new Date(at.getTime() + 1000), toolName: "send_confirmation", status: "ok", result: { body: {}, stage: "close", nextStep: null, ui: null } },
      { createdAt: new Date(at.getTime() + 2000), toolName: "broken", status: "error", result: { nonsense: true } },
    ];
    const all = eventsFrom(rows, 0);
    expect(all.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(all[0]!.ui).toEqual({ sms: "pay here" });
    expect(all[0]!.stage).toBe("pay");
    expect(all[2]!.ui).toBeNull();
    expect(all[2]!.stage).toBeNull();
    expect(eventsFrom(rows, 2).map((e) => e.seq)).toEqual([3]);
    expect(eventsFrom(rows, 3)).toEqual([]);
  });
});

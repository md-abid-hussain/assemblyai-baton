/**
 * buildSttParams (DESIGN §5.1.5) and the URL snapshot: `keyterms_prompt` and `prompt` are not echoed by `Begin`
 * (10b ST-9), so the exact query string `buildStreamingUrl` produces is pinned here (JSON-string arrays, exact names).
 */
import { describe, expect, it } from "vitest";
import { buildStreamingUrl, LIMITS } from "../../../../src/core/aai/streaming";
import {
  buildSttParams, bytesPerSampleOf, checkBeginConfiguration, hinglishChannel, keytermsFromPolicy, silenceByteOf, STT_FIXED_KEYTERMS,
  STT_PROMPT, sttFrameMs, TUNING_8K, TUNING_8K_GRID,
} from "../../../../src/core/aai/stt-params";
import type { CallManifestEntry, PolicyRecord } from "../../../../src/core/contracts";
import { call as call8k, policy } from "../../contracts/fixtures";

const call16k: CallManifestEntry = { ...call8k, source: "golden16k", format: { encoding: "pcm_s16le", sampleRate: 16000 } };

describe("keytermsFromPolicy", () => {
  it("takes names, agency, carrier, rep, vehicles, street, city + the fixed set; dedupes case-insensitively", () => {
    const k = keytermsFromPolicy(policy);
    expect(k).toEqual([
      "Priya", "Raman", "Priya Raman", "Arun Raman", "Harborview Insurance Agency", "Northbeam Mutual", "Daniel",
      "Honda", "Civic", "Honda Civic", "Toyota", "Highlander", "Toyota Highlander", "1427 Belle Avenue", "Lakewood",
      ...STT_FIXED_KEYTERMS,
    ]);
    // "Priya Raman" appears as policyholder and as existing driver: once.
    expect(k.filter((x) => x.toLowerCase() === "priya raman")).toHaveLength(1);
  });

  it("never exceeds the server limits (≤100 terms, ≤50 chars)", () => {
    const big: PolicyRecord = {
      ...policy,
      agencyName: "A".repeat(80),
      existingDrivers: Array.from({ length: 150 }, (_, i) => ({ name: `Driver Number ${i}`, relation: "other" })),
    };
    const k = keytermsFromPolicy(big);
    expect(k.length).toBe(LIMITS.keyterms);
    expect(k.every((t) => t.length <= LIMITS.keytermChars)).toBe(true);
    expect(k).not.toContain("A".repeat(80));
  });

  it("never uses the new driver's ground truth (the policy record has none)", () => {
    expect(keytermsFromPolicy(policy)).not.toContain("Maya");
  });
});

describe("buildSttParams", () => {
  it("8 kHz µ-law: model, mode, encoding, rate, inactivity, prompt, keyterms, TUNING_8K; no diarization/PII/gateway", () => {
    const p = buildSttParams(call8k, policy, "rep");
    expect(p).toMatchObject({
      speech_model: "universal-3-5-pro",
      encoding: "pcm_mulaw",
      sample_rate: 8000,
      mode: "min_latency",
      inactivity_timeout: 30,
      prompt: STT_PROMPT,
      ...TUNING_8K,
    });
    for (const k of ["speaker_labels", "redact_pii", "llm_gateway", "language_codes", "agent_context"]) expect(p).not.toHaveProperty(k);
    expect(STT_PROMPT.length).toBeLessThanOrEqual(LIMITS.promptChars);
  });

  it("16 kHz PCM16: no TUNING_8K", () => {
    const p = buildSttParams(call16k, policy, "customer");
    expect(p).toMatchObject({ encoding: "pcm_s16le", sample_rate: 16000 });
    expect(p).not.toHaveProperty("min_turn_silence");
    expect(p).not.toHaveProperty("max_turn_silence");
  });

  it("Hinglish per channel: s19-like = customer only, s20 = both; en FIRST", () => {
    const s19 = { ...call8k, scenarioId: "s19", language: "hinglish" as const };
    const s20 = { ...call8k, scenarioId: "s20", language: "hinglish" as const };
    expect(hinglishChannel(s19, "rep")).toBe(false);
    expect(hinglishChannel(s19, "customer")).toBe(true);
    expect(hinglishChannel(s20, "rep")).toBe(true);
    expect(hinglishChannel(call8k, "customer")).toBe(false);
    expect(buildSttParams(s19, policy, "customer")).toMatchObject({ language_codes: ["en", "hi"], language_detection: true });
    expect(buildSttParams(s19, policy, "rep")).not.toHaveProperty("language_codes");
  });

  it("seeds agent_context and clips it to its LAST 1750 chars", () => {
    const long = `${"x".repeat(2000)}THE END`;
    const p = buildSttParams(call8k, policy, "customer", { agentContext: long });
    expect(p.agent_context?.length).toBe(LIMITS.agentContextChars);
    expect(p.agent_context?.endsWith("THE END")).toBe(true);
  });

  it("tuning override for the T-D1-6 grid (and null = server defaults)", () => {
    for (const g of TUNING_8K_GRID) expect(buildSttParams(call8k, policy, "rep", { tuning8k: g })).toMatchObject(g);
    expect(buildSttParams(call8k, policy, "rep", { tuning8k: null })).not.toHaveProperty("min_turn_silence");
  });

  it("URL snapshot: exact wire names, JSON-string arrays, token last", () => {
    const url = buildStreamingUrl(buildSttParams(call8k, policy, "customer", { agentContext: "What's her date of birth?" }), { token: "TOKEN" });
    const u = new URL(url);
    expect(`${u.origin}${u.pathname}`).toBe("wss://streaming.assemblyai.com/v3/ws");
    expect([...u.searchParams.keys()]).toEqual([
      "speech_model", "encoding", "sample_rate", "mode", "inactivity_timeout", "keyterms_prompt", "prompt",
      "min_turn_silence", "max_turn_silence", "agent_context", "token",
    ]);
    expect(u.searchParams.get("speech_model")).toBe("universal-3-5-pro");
    expect(u.searchParams.get("encoding")).toBe("pcm_mulaw");
    expect(u.searchParams.get("sample_rate")).toBe("8000");
    expect(u.searchParams.get("mode")).toBe("min_latency");
    expect(u.searchParams.get("inactivity_timeout")).toBe("30");
    expect(u.searchParams.get("min_turn_silence")).toBe(String(TUNING_8K.min_turn_silence));
    expect(u.searchParams.get("max_turn_silence")).toBe(String(TUNING_8K.max_turn_silence));
    expect(JSON.parse(u.searchParams.get("keyterms_prompt")!)).toEqual(keytermsFromPolicy(policy));
    expect(u.searchParams.get("prompt")).toBe(STT_PROMPT);
    expect(u.searchParams.get("agent_context")).toBe("What's her date of birth?");
    expect(u.searchParams.get("token")).toBe("TOKEN");
    // The raw query (encoding pinned: arrays are JSON, spaces are '+').
    expect(url).toContain("keyterms_prompt=%5B%22Priya%22%2C%22Raman%22%2C%22Priya+Raman%22");
    expect(url).toContain("&prompt=Recorded+phone+call+at+a+US+insurance+agency.");
  });

  it("Hinglish URL: language_codes is a JSON array with en first", () => {
    const u = new URL(buildStreamingUrl(buildSttParams({ ...call16k, scenarioId: "s20", language: "hinglish" }, policy, "rep")));
    expect(u.searchParams.get("language_codes")).toBe('["en","hi"]');
    expect(u.searchParams.get("language_detection")).toBe("true");
  });

  it("format helpers", () => {
    expect(sttFrameMs(call8k.format)).toBe(100);
    expect(sttFrameMs(call16k.format)).toBe(50);
    expect(bytesPerSampleOf(call8k.format)).toBe(1);
    expect(bytesPerSampleOf(call16k.format)).toBe(2);
    expect(silenceByteOf(call8k.format)).toBe(0xff);
    expect(silenceByteOf(call16k.format)).toBe(0);
  });
});

describe("checkBeginConfiguration (§5.1.6 step 3)", () => {
  const begin = (configuration?: Record<string, unknown>) => ({ configuration });
  it("passes on the observed echo shape", () => {
    expect(checkBeginConfiguration(begin({ model: "universal-3-5-pro", mode: "min_latency", api_version: "2025-05-12" }))).toEqual({ ok: true, mismatches: [] });
    expect(checkBeginConfiguration(begin({ speech_model: "universal-3-5-pro", mode: "min_latency" })).ok).toBe(true);
  });
  it("flags a silently-ignored typo (default model / balanced mode)", () => {
    const r = checkBeginConfiguration(begin({ model: "universal-streaming-english", mode: "balanced" }));
    expect(r.ok).toBe(false);
    expect(r.mismatches).toHaveLength(2);
  });
  it("flags a missing configuration", () => {
    expect(checkBeginConfiguration(begin(undefined)).ok).toBe(false);
    expect(checkBeginConfiguration(null).ok).toBe(false);
  });
});

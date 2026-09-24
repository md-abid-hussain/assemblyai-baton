/**
 * client/va/first-update.ts - the first `session.update` from a CompiledTakeover (DESIGN §5.9.1), and a local guard.
 *
 * `buildFirstUpdate` emits exactly the live-verified shape (T-D1-0 PASS 4/4): system_prompt, greeting (never null),
 * input {format pcm 24k, transcription_mode, keyterms only when VA_KEYTERMS=1 and non-empty}, output {voice, format},
 * tools (interactive only).
 *
 * WP1's `validateFirstUpdate` (src/core/compiler/first-update.ts) is the authoritative whitelist and the controller
 * runs it when injected. `basicFirstUpdateGuard` is a conservative stand-in used only when it is not (before G1),
 * so no un-tested field can ever reach the socket. Both throw BatonError(E_VA_CONFIG) BEFORE a byte is sent.
 */
import "client-only";

import { VA_VOICES } from "@/core/aai/voice-agent";
import type { CompiledTakeover } from "@/core/contracts/takeover";
import { TRANSCRIPTION_MODES } from "@/core/contracts/takeover";
import { BatonError } from "@/core/contracts/errors";

export interface FirstUpdateMessage {
  type: "session.update";
  session: {
    system_prompt: string;
    greeting: string;
    input: { format: { encoding: "audio/pcm"; sample_rate: 24000 }; transcription_mode: CompiledTakeover["transcriptionMode"]; keyterms?: string[] };
    output: { voice: string; format: { encoding: "audio/pcm"; sample_rate: 24000 } };
    tools: CompiledTakeover["tools"];
  };
}

export function buildFirstUpdate(c: CompiledTakeover, o: { keytermsEnabled: boolean }): FirstUpdateMessage {
  const input: FirstUpdateMessage["session"]["input"] = {
    format: { encoding: "audio/pcm", sample_rate: 24000 },
    transcription_mode: c.transcriptionMode,
  };
  if (o.keytermsEnabled && c.keyterms.length > 0) input.keyterms = [...c.keyterms];
  return {
    type: "session.update",
    session: {
      system_prompt: c.systemPrompt,
      greeting: c.greeting,
      input,
      output: { voice: c.voice, format: { encoding: "audio/pcm", sample_rate: 24000 } },
      tools: c.tools.map((t) => ({ ...t })),
    },
  };
}

/** Largest system prompt live-sent in the Day-1 tests (T-D1-0: 3520 chars); WP1's validator owns the real limit. */
export const BASIC_GUARD_MAX_PROMPT_CHARS = 8000;
const ALLOWED_SCHEMA_KEYS = new Set(["type", "required", "properties", "enum", "description", "pattern", "examples", "items"]);

function checkSchema(node: unknown, path: string): void {
  if (node === null || typeof node !== "object" || Array.isArray(node)) return;
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (!ALLOWED_SCHEMA_KEYS.has(k)) throw new BatonError("E_VA_CONFIG", `first update: schema keyword "${k}" at ${path} is not allowed (§5.8)`);
    if (k === "properties" && v && typeof v === "object") for (const [pk, pv] of Object.entries(v)) checkSchema(pv, `${path}.properties.${pk}`);
    if (k === "items") checkSchema(v, `${path}.items`);
  }
}

/** Conservative local whitelist (§5.9.1). Throws BatonError(E_VA_CONFIG). */
export function basicFirstUpdateGuard(msg: { type: "session.update"; session: Record<string, unknown> }, opts: { keytermsEnabled: boolean }): void {
  const fail = (m: string): never => {
    throw new BatonError("E_VA_CONFIG", `first update: ${m}`);
  };
  const s = msg.session;
  for (const k of Object.keys(s)) if (!["system_prompt", "greeting", "input", "output", "tools"].includes(k)) fail(`session key "${k}" is not whitelisted`);
  if (typeof s.greeting !== "string" || s.greeting.trim() === "") fail("greeting must be a non-empty string");
  if (typeof s.system_prompt !== "string" || s.system_prompt.length === 0 || s.system_prompt.length > BASIC_GUARD_MAX_PROMPT_CHARS) fail("system_prompt missing or too long");
  const input = (s.input ?? {}) as Record<string, unknown>;
  for (const k of Object.keys(input)) if (!["format", "transcription_mode", "keyterms"].includes(k)) fail(`input key "${k}" is not whitelisted`);
  if (!TRANSCRIPTION_MODES.includes(input.transcription_mode as never)) fail("input.transcription_mode invalid");
  const fmt = JSON.stringify(input.format);
  if (fmt !== JSON.stringify({ encoding: "audio/pcm", sample_rate: 24000 })) fail("input.format must be pcm 24000");
  if (input.keyterms !== undefined) {
    if (!opts.keytermsEnabled) fail("keyterms sent while VA_KEYTERMS is off");
    const kt = input.keyterms;
    if (!Array.isArray(kt) || kt.length > 100 || kt.some((x) => typeof x !== "string" || x.length === 0 || x.length > 50)) fail("keyterms: ≤100 strings of ≤50 chars");
  }
  const output = (s.output ?? {}) as Record<string, unknown>;
  for (const k of Object.keys(output)) if (!["voice", "format"].includes(k)) fail(`output key "${k}" is not whitelisted`);
  if (!VA_VOICES.includes(output.voice as never)) fail(`output.voice "${String(output.voice)}" is not one of the 18 verified voices`);
  if (JSON.stringify(output.format) !== JSON.stringify({ encoding: "audio/pcm", sample_rate: 24000 })) fail("output.format must be pcm 24000");
  const tools = s.tools;
  if (!Array.isArray(tools)) fail("tools must be an array");
  for (const [i, t] of (tools as Record<string, unknown>[]).entries()) {
    if (t.type !== "function") fail(`tools[${i}].type must be "function"`);
    if (t.execution_mode !== "interactive") fail(`tools[${i}].execution_mode must be "interactive" in the first update`);
    if (typeof t.timeout_seconds !== "number" || t.timeout_seconds > 30 || t.timeout_seconds <= 0) fail(`tools[${i}].timeout_seconds must be 1..30`);
    if ("http" in t) fail(`tools[${i}] has an http block (T-D1-5: rejected inline)`);
    checkSchema(t.parameters, `tools[${i}].parameters`);
  }
}

/**
 * compiler/first-update.ts - the first `session.update` of a takeover and its whitelist validator (DESIGN §5.9.1).
 * WP1 early deliverable; runs on the server at compile AND on the client before sending (WP5, WP5b).
 *
 * A bad first update is fatal (close 1008, research 10 §3.5), so anything outside the live-verified whitelist
 * throws `BatonError("E_VA_CONFIG")` before a byte is sent.
 */
import { BatonError } from "../contracts/errors";
import type { CompiledTakeover, TranscriptionMode } from "../contracts/takeover";
import { TRANSCRIPTION_MODES } from "../contracts/takeover";
import { TOOL_NAMES, type VaFunctionTool } from "../contracts/tools";
import { VA_VOICES } from "../aai/voice-agent";
import { ALLOWED_SCHEMA_KEYWORDS } from "./tool-schemas";

/** The only audio format Baton sends and receives: PCM16 24 kHz both ways (§5.9.1). */
export const VA_AUDIO_FORMAT = { encoding: "audio/pcm", sample_rate: 24000 } as const;

export const KEYTERMS_MAX = 100;
export const KEYTERM_MAX_CHARS = 50;
/**
 * Upper bound for `system_prompt`. The template is < 3500 chars and the case JSON ≤ 1800 (§5.7), so compiled
 * prompts stay under ~6000; T-D1-0 sends the real compiled prompts. 8000 is the whitelist bound.
 */
export const SYSTEM_PROMPT_MAX_CHARS = 8000;
export const TOOL_TIMEOUT_MAX_S = 30;

/** A type alias (not an interface) so it is assignable to the contract's `Record<string, unknown>` session. */
export type FirstUpdateSession = {
  system_prompt: string;
  greeting: string;
  input: { format: { encoding: "audio/pcm"; sample_rate: 24000 }; transcription_mode: TranscriptionMode; keyterms?: string[] };
  output: { voice: string; format: { encoding: "audio/pcm"; sample_rate: 24000 } };
  tools: VaFunctionTool[];
};
export type FirstUpdateMessage = {
  type: "session.update";
  session: FirstUpdateSession;
};

/**
 * Build the first `session.update` from a compiled takeover (§5.9.1). `input.keyterms` is included only when the
 * compiled list is non-empty (the compiler leaves it `[]` unless `VA_KEYTERMS=1`). Key order is fixed, so the JSON
 * is byte-stable for the T-D1-0 fixtures.
 */
export function buildFirstUpdate(compiled: Pick<CompiledTakeover, "systemPrompt" | "greeting" | "transcriptionMode" | "keyterms" | "voice" | "tools">): FirstUpdateMessage {
  const input: FirstUpdateSession["input"] = {
    format: { ...VA_AUDIO_FORMAT },
    transcription_mode: compiled.transcriptionMode,
    ...(compiled.keyterms.length ? { keyterms: [...compiled.keyterms] } : {}),
  };
  return {
    type: "session.update",
    session: {
      system_prompt: compiled.systemPrompt,
      greeting: compiled.greeting,
      input,
      output: { voice: compiled.voice, format: { ...VA_AUDIO_FORMAT } },
      tools: compiled.tools.map((t) => JSON.parse(JSON.stringify(t)) as VaFunctionTool),
    },
  };
}

const fail = (msg: string): never => {
  throw new BatonError("E_VA_CONFIG", `first session.update rejected: ${msg}`);
};
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const keysSubset = (o: Record<string, unknown>, allowed: readonly string[], where: string) => {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) fail(`${where}: key "${k}" is not whitelisted`);
};

function checkFormat(f: unknown, where: string): void {
  if (!isObj(f)) fail(`${where} must be an object`);
  const o = f as Record<string, unknown>;
  keysSubset(o, ["encoding", "sample_rate"], where);
  if (o.encoding !== VA_AUDIO_FORMAT.encoding || o.sample_rate !== VA_AUDIO_FORMAT.sample_rate) {
    fail(`${where} must be exactly {encoding:"audio/pcm", sample_rate:24000}`);
  }
}

/** Recursively check a parameters schema against the §5.8 keyword whitelist. */
export function checkToolSchema(schema: unknown, where: string): void {
  if (!isObj(schema)) fail(`${where} must be an object schema`);
  const s = schema as Record<string, unknown>;
  keysSubset(s, ALLOWED_SCHEMA_KEYWORDS, where);
  if (typeof s.type !== "string") fail(`${where}.type must be a string`);
  if (s.description !== undefined && typeof s.description !== "string") fail(`${where}.description must be a string`);
  if (s.pattern !== undefined && typeof s.pattern !== "string") fail(`${where}.pattern must be a string`);
  if (s.enum !== undefined && (!Array.isArray(s.enum) || s.enum.length === 0)) fail(`${where}.enum must be a non-empty array`);
  if (s.examples !== undefined && !Array.isArray(s.examples)) fail(`${where}.examples must be an array`);
  if (s.type === "object") {
    const props = s.properties ?? {};
    if (!isObj(props)) fail(`${where}.properties must be an object`);
    const p = props as Record<string, unknown>;
    for (const [name, sub] of Object.entries(p)) checkToolSchema(sub, `${where}.properties.${name}`);
    if (s.required !== undefined) {
      if (!Array.isArray(s.required) || s.required.some((r) => typeof r !== "string" || !(r in p))) {
        fail(`${where}.required must list declared properties`);
      }
    }
  } else if (s.properties !== undefined || s.required !== undefined) {
    fail(`${where}: properties/required only on object schemas`);
  }
}

/**
 * `validateFirstUpdate(msg, {keytermsEnabled})` (§5.9.1 whitelist). Throws `BatonError("E_VA_CONFIG")` on:
 * unknown top-level/session/input/output keys; a missing or empty greeting; an empty or oversized system prompt;
 * keyterms while the flag is off, > 100 items or any > 50 chars; an unknown transcription mode or voice; any
 * format other than PCM16 24 kHz; any tool that is not a known `function` tool with `execution_mode:"interactive"`
 * and `timeout_seconds` ≤ 30, or whose parameters use a keyword outside §5.8.
 */
export function validateFirstUpdate(msg: { type: "session.update"; session: Record<string, unknown> }, opts: { keytermsEnabled: boolean }): void {
  if (!isObj(msg)) fail("message must be an object");
  keysSubset(msg as unknown as Record<string, unknown>, ["type", "session"], "message");
  if (msg.type !== "session.update") fail(`type must be "session.update"`);
  const s = msg.session;
  if (!isObj(s)) fail("session must be an object");
  keysSubset(s, ["system_prompt", "greeting", "input", "output", "tools"], "session");

  if (typeof s.greeting !== "string" || !s.greeting.trim()) fail("greeting must be a non-empty string (never null or omitted)");
  if (typeof s.system_prompt !== "string" || !s.system_prompt.trim()) fail("system_prompt must be a non-empty string");
  if ((s.system_prompt as string).length > SYSTEM_PROMPT_MAX_CHARS) fail(`system_prompt exceeds ${SYSTEM_PROMPT_MAX_CHARS} chars`);

  if (!isObj(s.input)) fail("input must be an object");
  const input = s.input as Record<string, unknown>;
  keysSubset(input, ["format", "transcription_mode", "keyterms"], "input");
  checkFormat(input.format, "input.format");
  if (!(TRANSCRIPTION_MODES as readonly unknown[]).includes(input.transcription_mode)) fail("input.transcription_mode is not a known mode");
  if (input.keyterms !== undefined) {
    if (!opts.keytermsEnabled) fail("input.keyterms sent while VA_KEYTERMS is off");
    const kt = input.keyterms;
    if (!Array.isArray(kt)) fail("input.keyterms must be an array");
    const arr = kt as unknown[];
    if (arr.length > KEYTERMS_MAX) fail(`input.keyterms has ${arr.length} items (max ${KEYTERMS_MAX})`);
    for (const k of arr) {
      if (typeof k !== "string" || !k.trim()) fail("input.keyterms items must be non-empty strings");
      if ((k as string).length > KEYTERM_MAX_CHARS) fail(`keyterm "${k as string}" exceeds ${KEYTERM_MAX_CHARS} chars`);
    }
  }

  if (!isObj(s.output)) fail("output must be an object");
  const output = s.output as Record<string, unknown>;
  keysSubset(output, ["voice", "format"], "output");
  if (!(VA_VOICES as readonly unknown[]).includes(output.voice)) fail(`output.voice "${String(output.voice)}" is not one of the verified voices`);
  checkFormat(output.format, "output.format");

  if (!Array.isArray(s.tools)) fail("tools must be an array");
  const seen = new Set<string>();
  for (const [i, t] of (s.tools as unknown[]).entries()) {
    const where = `tools[${i}]`;
    if (!isObj(t)) fail(`${where} must be an object`);
    const tool = t as Record<string, unknown>;
    keysSubset(tool, ["type", "name", "description", "parameters", "execution_mode", "timeout_seconds"], where);
    if (tool.type !== "function") fail(`${where}.type must be "function"`);
    if (!(TOOL_NAMES as readonly unknown[]).includes(tool.name)) fail(`${where}.name "${String(tool.name)}" is not a Baton tool`);
    if (seen.has(tool.name as string)) fail(`${where}.name "${String(tool.name)}" is duplicated`);
    seen.add(tool.name as string);
    if (typeof tool.description !== "string" || !tool.description) fail(`${where}.description must be a non-empty string`);
    if (tool.execution_mode !== "interactive") fail(`${where} (${String(tool.name)}): execution_mode must be "interactive" in the first update`);
    const to = tool.timeout_seconds;
    if (typeof to !== "number" || !Number.isInteger(to) || to <= 0 || to > TOOL_TIMEOUT_MAX_S) fail(`${where}.timeout_seconds must be an integer in 1..${TOOL_TIMEOUT_MAX_S}`);
    const params = tool.parameters;
    checkToolSchema(params, `${where}.parameters`);
    if ((params as Record<string, unknown>).type !== "object") fail(`${where}.parameters.type must be "object"`);
  }
}

/** Non-throwing variant for UIs and scripts. */
export function firstUpdateErrors(msg: { type: "session.update"; session: Record<string, unknown> }, opts: { keytermsEnabled: boolean }): string | null {
  try {
    validateFirstUpdate(msg, opts);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

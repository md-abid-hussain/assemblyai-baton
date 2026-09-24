/**
 * env.ts - load secrets from the project-root .env (C:/Users/abid1/Desktop/assembly-ai/.env),
 * assert that the required keys exist, and export them.
 *
 * Rules:
 *  - Never print key values. Use `mask()` / `envSummary()` when you need to reference them.
 *  - `.env` values take precedence over whatever is already in the shell environment
 *    (so a stale exported OPENAI_API_KEY cannot silently win).
 *  - The file is only read, never written.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { parse } from "dotenv";
import { registerSecrets } from "./log.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

/** C:/Users/abid1/Desktop/assembly-ai */
export const PROJECT_ROOT = resolve(HERE, "..", "..");
/** C:/Users/abid1/Desktop/assembly-ai/spikes */
export const SPIKES_ROOT = resolve(HERE, "..");
/** C:/Users/abid1/Desktop/assembly-ai/spikes/out */
export const OUT_DIR = resolve(SPIKES_ROOT, "out");
/** C:/Users/abid1/Desktop/assembly-ai/spikes/fixtures */
export const FIXTURES_DIR = resolve(SPIKES_ROOT, "fixtures");
/** C:/Users/abid1/Desktop/assembly-ai/.env */
export const ENV_PATH = resolve(PROJECT_ROOT, ".env");

const REQUIRED = ["ASSEMBLYAI_API_KEY", "OPENAI_API_KEY"] as const;
const OPTIONAL = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER"] as const;
const SECRET_NAMES = [...REQUIRED, "TWILIO_AUTH_TOKEN"] as const;

type RequiredName = (typeof REQUIRED)[number];

function loadDotenv(): Record<string, string> {
  if (!existsSync(ENV_PATH)) {
    throw new Error(`[env] .env not found at ${ENV_PATH}`);
  }
  const parsed = parse(readFileSync(ENV_PATH));
  // Strip inline comments the dotenv parser keeps for unquoted values ("   # E.164 ...").
  const out: Record<string, string> = {};
  for (const [k, raw] of Object.entries(parsed)) {
    const v = raw.replace(/\s+#.*$/, "").trim();
    out[k] = v;
    process.env[k] = v; // override: .env wins over the shell
  }
  return out;
}

const fileEnv = loadDotenv();

function requireKey(name: RequiredName): string {
  const v = fileEnv[name] ?? "";
  if (!v) throw new Error(`[env] ${name} is missing or empty in ${ENV_PATH}`);
  if (/\s/.test(v)) throw new Error(`[env] ${name} contains whitespace (value not shown)`);
  if (v.length < 16) throw new Error(`[env] ${name} looks too short (${v.length} chars; value not shown)`);
  return v;
}

export const ASSEMBLYAI_API_KEY: string = requireKey("ASSEMBLYAI_API_KEY");
export const OPENAI_API_KEY: string = requireKey("OPENAI_API_KEY");
export const TWILIO_ACCOUNT_SID: string | undefined = fileEnv.TWILIO_ACCOUNT_SID || undefined;
export const TWILIO_AUTH_TOKEN: string | undefined = fileEnv.TWILIO_AUTH_TOKEN || undefined;
export const TWILIO_PHONE_NUMBER: string | undefined = fileEnv.TWILIO_PHONE_NUMBER || undefined;

registerSecrets(ASSEMBLYAI_API_KEY, OPENAI_API_KEY, TWILIO_AUTH_TOKEN);

/** Mask a secret: first 3 chars + "..." + last 2 chars + length. Never returns the whole value. */
export function mask(value: string | undefined | null): string {
  if (!value) return "<empty>";
  if (value.length <= 8) return `***(${value.length})`;
  return `${value.slice(0, 3)}...${value.slice(-2)}(${value.length})`;
}

/** Every secret value currently loaded (used by the logger to scrub accidental leaks). */
export function secretValues(): string[] {
  const vals: string[] = [];
  for (const n of SECRET_NAMES) {
    const v = fileEnv[n];
    if (v && v.length >= 8) vals.push(v);
  }
  return vals;
}

/** Replace any loaded secret value that appears inside `text` with its masked form. */
export function scrubSecrets(text: string): string {
  let out = text;
  for (const s of secretValues()) {
    if (out.includes(s)) out = out.split(s).join(mask(s));
  }
  return out;
}

/** Safe-to-print summary: which keys are present, masked. */
export function envSummary(): Record<string, string> {
  const o: Record<string, string> = {};
  for (const n of [...REQUIRED, ...OPTIONAL]) o[n] = n === "TWILIO_PHONE_NUMBER" || n === "TWILIO_ACCOUNT_SID" ? (fileEnv[n] ? "<set>" : "<empty>") : mask(fileEnv[n]);
  return o;
}

/**
 * Convenience bundle. `console.log(keys)` / `JSON.stringify(keys)` print masked values only;
 * property access (`keys.assemblyai`) returns the real key.
 */
export const keys = Object.freeze(
  Object.defineProperties(
    {} as { readonly assemblyai: string; readonly openai: string },
    {
      assemblyai: { value: ASSEMBLYAI_API_KEY, enumerable: false },
      openai: { value: OPENAI_API_KEY, enumerable: false },
      toJSON: { value: () => ({ assemblyai: mask(ASSEMBLYAI_API_KEY), openai: mask(OPENAI_API_KEY) }), enumerable: false },
      [inspect.custom]: { value: () => `Keys { assemblyai: ${mask(ASSEMBLYAI_API_KEY)}, openai: ${mask(OPENAI_API_KEY)} }`, enumerable: false },
    },
  ),
);

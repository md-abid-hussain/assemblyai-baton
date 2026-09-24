import "server-only";

import { z } from "zod";

/**
 * `env()`: zod-validated `process.env` (DESIGN §3.4, fix 5.3-5). Lazy: parsed on first use, cached.
 *
 * Rules:
 *  - never prints, logs or embeds a value: errors list variable NAMES only;
 *  - empty strings count as unset (`POLAR_WEBHOOK_SECRET=` in `.env` is "missing");
 *  - secrets are optional in the schema, so a partly configured deploy still boots and `/api/health` answers.
 *    Code that needs a secret calls `requireEnv("NAME", …)`, which throws `EnvError` naming the missing ones;
 *  - there is no `NEXT_PUBLIC_*` variable (DESIGN §3.4).
 */

const str = () => z.string().min(1);
const optStr = () => z.string().min(1).optional();
const num = (def: number) => z.coerce.number().finite().default(def);
const flag01 = (def: "0" | "1") =>
  z
    .enum(["0", "1"])
    .default(def)
    .transform((v) => v === "1");
const isoDate = () => z.string().refine((s) => !Number.isNaN(Date.parse(s)), { message: "expected an ISO date/time" });

const jsonRecord = z.string().transform((s, ctx) => {
  try {
    const parsed = z.record(z.string(), z.string()).safeParse(JSON.parse(s));
    if (parsed.success) return parsed.data;
  } catch {
    /* fall through */
  }
  ctx.addIssue({ code: "custom", message: "expected a JSON object of strings" });
  return z.NEVER;
});

const commaList = z.string().transform((s) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean),
);

export const EnvSchema = z.object({
  // ---- platform ----
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  HOSTNAME: optStr(),
  DATABASE_URL: optStr(),
  APP_URL: optStr(),
  BATON_DEPLOY_ID: z.string().min(1).default("dev-local"),
  ENABLE_INPROC_WORKER: flag01("0"),

  // ---- AssemblyAI / OpenAI (secrets) ----
  ASSEMBLYAI_API_KEY: optStr(),
  OPENAI_API_KEY: optStr(),

  // ---- Polar ----
  POLAR_SERVER: z.enum(["sandbox", "production"]).default("sandbox"),
  POLAR_ACCESS_TOKEN: optStr(),
  POLAR_PRODUCT_ID: optStr(),
  POLAR_WEBHOOK_SECRET: optStr(),
  POLAR_DEMO_CUSTOMER_EMAIL: optStr(),
  POLAR_DEMO_CUSTOMERS: jsonRecord.optional(),
  EMBED_ORIGINS: commaList.default([]),
  PAYMENTS_MODE: z.enum(["polar", "mock"]).default("mock"),

  // ---- app secrets (npm run secrets:init fills these locally) ----
  CASE_TOKEN_SECRET: optStr(),
  VISITOR_SECRET: optStr(),
  ADMIN_KEY: optStr(),
  CRON_SECRET: optStr(),
  AAI_WEBHOOK_SECRET: optStr(),
  AGENT_TOOL_SECRET: optStr(),

  // ---- limits authority (DESIGN §2.3) ----
  LIMITS_ROLE: z.enum(["authority", "remote"]).optional(),
  LIMITS_AUTHORITY_URL: optStr(),
  LIMITS_AUTHORITY_KEY: optStr(),

  // ---- ledger and caps (DESIGN §7.2, §7.3) ----
  LEDGER_EPOCH: isoDate().optional(),
  AAI_JUDGING_BUDGET_USD: num(28),
  AAI_RESERVE_USD: num(5),
  AAI_DAILY_CAP_MAX_USD: num(3),
  JUDGING_END_DATE: isoDate().default("2026-10-21"),
  OPENAI_DAILY_CAP_USD: num(3),
  STT_OPENS_PER_MIN: z.coerce.number().int().positive().default(4),
  STT_QUEUE_MAX_WAIT_S: z.coerce.number().int().positive().default(15),
  VA_MAX_CONCURRENT: z.coerce.number().int().positive().default(3),
  VA_SESSION_CAP_BASE_MS: z.coerce.number().int().positive().default(150_000),
  VA_SESSION_CAP_PER_FIELD_MS: z.coerce.number().int().nonnegative().default(15_000),
  VA_SESSION_CAP_MAX_MS: z.coerce.number().int().positive().default(420_000),

  // ---- Voice Agent and product switches ----
  VA_KEYTERMS: flag01("0"),
  VA_VOICE: z.string().min(1).default("alba"),
  PAY_TOOL_MODE: z.enum(["hold", "push"]).default("hold"),
  FEATURE_BE_CUSTOMER: flag01("0"),
});

export type Env = z.output<typeof EnvSchema>;
export type EnvName = keyof Env;

/** Every name the app reads (DESIGN §3.4); `TWILIO_*` belong to the recording kit and are not deployed. */
export const ENV_NAMES = Object.keys(EnvSchema.shape) as EnvName[];

export class EnvError extends Error {
  readonly missing: string[];
  readonly invalid: string[];
  constructor(missing: string[], invalid: string[]) {
    const parts: string[] = [];
    if (missing.length) parts.push(`missing: ${missing.join(", ")}`);
    if (invalid.length) parts.push(`invalid: ${invalid.join(", ")}`);
    super(`[env] ${parts.join("; ")} (values are never printed)`);
    this.name = "EnvError";
    this.missing = missing;
    this.invalid = invalid;
  }
}

/** Snapshot of the relevant `process.env` entries with empty strings removed. */
function readRaw(source: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ENV_NAMES) {
    const v = source[name];
    if (typeof v === "string" && v.trim() !== "") out[name] = v.trim();
  }
  return out;
}

/** Parse an env-like record. Throws `EnvError` (names only) on invalid values. Exported for tests. */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const r = EnvSchema.safeParse(readRaw(source));
  if (r.success) return r.data;
  const invalid = [...new Set(r.error.issues.map((i) => `${String(i.path[0] ?? "?")} (${i.message})`))];
  throw new EnvError([], invalid);
}

let cached: Env | null = null;

/** The validated environment (lazy, cached). */
export function env(): Env {
  if (!cached) cached = parseEnv(process.env);
  return cached;
}

/** Drop the cache (tests, or after `process.env` changed in a script). */
export function resetEnvCache(): void {
  cached = null;
}

type Required<K extends EnvName> = { [P in K]: NonNullable<Env[P]> };

/**
 * Assert that these variables are present and return them narrowed. Throws `EnvError` listing only the
 * missing names, e.g. `requireEnv("ASSEMBLYAI_API_KEY")` in the token mint.
 */
export function requireEnv<K extends EnvName>(...names: K[]): Required<K> {
  const e = env();
  const missing = names.filter((n) => e[n] === undefined || e[n] === null);
  if (missing.length) throw new EnvError(missing as string[], []);
  const out = {} as Required<K>;
  for (const n of names) (out as Record<string, unknown>)[n] = e[n];
  return out;
}

/** Names (never values) of the given variables that are unset. */
export function missingEnv(names: readonly EnvName[]): EnvName[] {
  const e = env();
  return names.filter((n) => e[n] === undefined || e[n] === null);
}

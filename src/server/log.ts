import "server-only";

/**
 * Structured JSON-line logger (Zerops log collection reads stdout/stderr; DESIGN §7.7, §8.1).
 * Promoted from spikes/lib/log.ts: `redact()`, `registerSecrets()` and the base64/token masking are kept;
 * the JSONL file writer is replaced by one `console` JSON line per event.
 *
 * Rules:
 *  - every registered secret value is masked wherever it appears (strings, nested objects, error messages);
 *  - sensitive keys (authorization, token, secret, …) are always masked;
 *  - `?token=` style query params and JWT-looking strings are masked by pattern;
 *  - audio/base64 payloads are summarised as `{bytes}`;
 *  - never log turn text (DESIGN §8.3): pass lengths and ids.
 */

// ---------------------------------------------------------------------------------------------
// Secret registry
// ---------------------------------------------------------------------------------------------

const secrets = new Set<string>();
/** Env names that always hold secrets (DESIGN §3.4 "S" column). Their values are registered on first log. */
export const SECRET_ENV_NAMES = [
  "ASSEMBLYAI_API_KEY",
  "OPENAI_API_KEY",
  "POLAR_ACCESS_TOKEN",
  "POLAR_WEBHOOK_SECRET",
  "CASE_TOKEN_SECRET",
  "VISITOR_SECRET",
  "ADMIN_KEY",
  "CRON_SECRET",
  "AAI_WEBHOOK_SECRET",
  "AGENT_TOOL_SECRET",
  "LIMITS_AUTHORITY_KEY",
  "TWILIO_AUTH_TOKEN",
] as const;

/** Register secret values that must never appear in logs. Values shorter than 8 chars are ignored. */
export function registerSecrets(...values: (string | undefined | null)[]): void {
  for (const v of values) if (v && v.length >= 8) secrets.add(v);
}

let envRegistered = false;
/** Register every secret-looking value from `process.env` (idempotent; re-run with `force` after env changes). */
export function registerSecretsFromEnv(force = false): void {
  if (envRegistered && !force) return;
  envRegistered = true;
  for (const n of SECRET_ENV_NAMES) registerSecrets(process.env[n]);
  for (const [k, v] of Object.entries(process.env)) {
    if (v && v.length >= 16 && /(API_KEY|_TOKEN|SECRET|PASSWORD|_KEY)$/i.test(k)) secrets.add(v);
  }
  // The DB password inside DATABASE_URL.
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl) {
    try {
      const pw = decodeURIComponent(new URL(dbUrl).password);
      registerSecrets(pw);
    } catch {
      /* not a URL */
    }
  }
}

export function maskValue(v: string): string {
  if (v.length <= 8) return `***(${v.length})`;
  return `${v.slice(0, 3)}...${v.slice(-2)}(${v.length})`;
}

const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const QUERY_SECRET_RE = /([?&](?:token|api_key|apikey|key|access_token|secret)=)([^&\s"']+)/gi;
const URL_PASSWORD_RE = /(\b[a-z][a-z0-9+.-]*:\/\/[^:/\s"']+:)([^@\s"']+)(@)/gi;

/** Mask registered secrets, token query params, JWTs and URL passwords inside a string. */
export function scrub(s: string): string {
  let out = s;
  for (const sec of secrets) if (out.includes(sec)) out = out.split(sec).join(maskValue(sec));
  out = out.replace(QUERY_SECRET_RE, (_m, p: string, v: string) => p + maskValue(v));
  out = out.replace(JWT_RE, (m) => maskValue(m));
  out = out.replace(URL_PASSWORD_RE, (_m, a: string, pw: string, b: string) => a + maskValue(pw) + b);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------------------------

const AUDIO_KEYS = new Set(["audio", "data", "delta", "chunk", "payload", "audio_data", "audio_base64", "b64", "pcm", "bytes_b64"]);
const SENSITIVE_KEYS = new Set([
  "authorization",
  "api_key",
  "apikey",
  "x-api-key",
  "x-admin-key",
  "x-cron-secret",
  "x-limits-key",
  "x-baton-webhook",
  "x-baton-agent-key",
  "webhook_auth_header_value",
  "token",
  "access_token",
  "temp_token",
  "casetoken",
  "takeovertoken",
  "password",
  "secret",
  "client_secret",
  "auth_token",
  "cookie",
  "set-cookie",
]);
const B64_RE = /^[A-Za-z0-9+/_-]+={0,2}$/;

export interface RedactOptions {
  maxString?: number;
  maxArray?: number;
  maxDepth?: number;
}

export const base64ByteLength = (b64: string): number => {
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
};

/** Return a JSON-safe, redacted deep copy of `value`. */
export function redact(value: unknown, opts: RedactOptions = {}, key?: string, depth = 0, seen = new WeakSet<object>()): unknown {
  const maxString = opts.maxString ?? 4000;
  const maxArray = opts.maxArray ?? 200;
  const maxDepth = opts.maxDepth ?? 16;
  const k = key?.toLowerCase();

  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "string") {
    if (k && SENSITIVE_KEYS.has(k)) return maskValue(value.replace(/^(Bearer|Basic)\s+/i, ""));
    if (value.length >= 16 && B64_RE.test(value) && ((k && AUDIO_KEYS.has(k)) || value.length >= 512)) {
      return k && AUDIO_KEYS.has(k) ? { bytes: base64ByteLength(value) } : { bytes: base64ByteLength(value), b64: true };
    }
    const s = scrub(value);
    return s.length > maxString ? `${s.slice(0, maxString)}...[+${s.length - maxString} chars]` : s;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return undefined;
  if (value instanceof ArrayBuffer) return { bytes: value.byteLength };
  if (ArrayBuffer.isView(value)) return { bytes: value.byteLength };
  if (value instanceof Error) {
    const e: Record<string, unknown> = { error: value.name, message: scrub(value.message) };
    const code = (value as { code?: unknown }).code;
    if (typeof code === "string" || typeof code === "number") e.code = code;
    if (value.stack) e.stack = scrub(value.stack.split("\n").slice(0, 5).join(" | "));
    return e;
  }
  if (value instanceof Date) return value.toISOString();
  if (value instanceof URL) return scrub(value.toString());
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[circular]";
  if (depth >= maxDepth) return "[max depth]";
  seen.add(value);
  if (Array.isArray(value)) {
    const arr = value.slice(0, maxArray).map((v) => redact(v, opts, key, depth + 1, seen));
    if (value.length > maxArray) arr.push(`...[+${value.length - maxArray} items]`);
    return arr;
  }
  if (value instanceof Map) return redact(Object.fromEntries(value), opts, key, depth + 1, seen);
  if (typeof Headers !== "undefined" && value instanceof Headers) {
    return redact(Object.fromEntries(value.entries()), opts, key, depth + 1, seen);
  }
  const out: Record<string, unknown> = {};
  for (const [kk, vv] of Object.entries(value as Record<string, unknown>)) {
    const r = redact(vv, opts, kk, depth + 1, seen);
    if (r !== undefined) out[kk] = r;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------------------------

export type LogLevel = "debug" | "info" | "warn" | "error";
const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function minLevel(): LogLevel {
  const v = (process.env.LOG_LEVEL ?? "").toLowerCase();
  if (v === "debug" || v === "info" || v === "warn" || v === "error") return v;
  return process.env.NODE_ENV === "production" ? "info" : "debug";
}

/** Sink for tests; defaults to console (stderr for warn/error). */
export type LogSink = (level: LogLevel, line: string) => void;
let sink: LogSink = (level, line) => {
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
};
/** Replace the output sink (tests). Returns a function that restores the previous sink. */
export function setLogSink(s: LogSink): () => void {
  const prev = sink;
  sink = s;
  return () => {
    sink = prev;
  };
}

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown> | unknown): void;
  /** A logger whose lines always carry `bindings` (e.g. `{ component: "limits" }`). */
  child(bindings: Record<string, unknown>): Logger;
}

function write(level: LogLevel, bindings: Record<string, unknown>, msg: string, data: unknown): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel()]) return;
  registerSecretsFromEnv();
  const payload =
    data === undefined ? {} : data instanceof Error ? { err: data } : typeof data === "object" && data !== null ? data : { value: data };
  const line = {
    t: new Date().toISOString(),
    level,
    msg: scrub(msg),
    ...(redact(bindings) as Record<string, unknown>),
    ...(redact(payload) as Record<string, unknown>),
  };
  let text: string;
  try {
    text = JSON.stringify(line);
  } catch {
    text = JSON.stringify({ t: line.t, level, msg: line.msg, note: "unserialisable log payload" });
  }
  sink(level, text);
}

export function createLogger(bindings: Record<string, unknown> = {}): Logger {
  return {
    debug: (m, d) => write("debug", bindings, m, d),
    info: (m, d) => write("info", bindings, m, d),
    warn: (m, d) => write("warn", bindings, m, d),
    error: (m, d) => write("error", bindings, m, d),
    child: (b) => createLogger({ ...bindings, ...b }),
  };
}

/** The app-wide logger. Use `log.child({ component: "…" })` per module. */
export const log: Logger = createLogger();

let processHooksInstalled = false;
/** Log unhandled promise rejections as JSON lines (called once from `src/instrumentation.ts`, Node runtime only). */
export function installProcessErrorLogging(): void {
  if (processHooksInstalled) return;
  processHooksInstalled = true;
  const boot = log.child({ component: "process" });
  process.on("unhandledRejection", (reason) => boot.error("unhandledRejection", { err: reason }));
}

/** One boot line: version, deploy id, role, worker flag and Node version (never env values beyond these). */
export function logBoot(info: { version: string; inprocWorker: boolean }): void {
  log.child({ component: "boot" }).info("server starting", {
    version: info.version,
    deployId: process.env.BATON_DEPLOY_ID ?? "dev-local",
    limitsRole: process.env.LIMITS_ROLE ?? "(unset)",
    inprocWorker: info.inprocWorker,
    node: process.version,
  });
}

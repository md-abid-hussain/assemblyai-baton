/**
 * log.ts - JSONL event logger for spikes. One file per test: spikes/out/<test>.jsonl
 *
 * Every line: {"t": ISO time, "ms": ms since logger start, "dir": "in"|"out"|"note"|..., "type"?: event type, "data": ...}
 *
 * Redaction (applied to everything written, including console echo):
 *  - Buffers / typed arrays / ArrayBuffers                  -> {"bytes": n}
 *  - base64 strings under audio-ish keys (audio, data, ...) -> {"bytes": n}   (decoded byte length)
 *  - any other long (>= 512 chars) base64-looking string    -> {"bytes": n, "b64": true}
 *  - sensitive keys (authorization, api_key, token, ...)    -> masked "abc...yz(40)"
 *  - "token=..." inside URLs, and any registered secret value anywhere -> masked
 *  - very long plain strings truncated (default 4000 chars), very long arrays truncated (default 500)
 */
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "out");

// ---------------------------------------------------------------------------------------------
// Secret registry
// ---------------------------------------------------------------------------------------------

const secrets = new Set<string>();

/** Register secret values that must never appear in logs (env.ts registers the API keys). */
export function registerSecrets(...values: (string | undefined | null)[]): void {
  for (const v of values) if (v && v.length >= 8) secrets.add(v);
}

function registerFromProcessEnv(): void {
  for (const [k, v] of Object.entries(process.env)) {
    if (v && v.length >= 16 && /(API_KEY|_TOKEN|SECRET|PASSWORD)$/i.test(k)) secrets.add(v);
  }
}

export function maskValue(v: string): string {
  if (v.length <= 8) return `***(${v.length})`;
  return `${v.slice(0, 3)}...${v.slice(-2)}(${v.length})`;
}

function scrub(s: string): string {
  let out = s;
  for (const sec of secrets) if (out.includes(sec)) out = out.split(sec).join(maskValue(sec));
  // token / key query params in URLs
  out = out.replace(/([?&](?:token|api_key|apikey|key|access_token)=)([^&\s"']+)/gi, (_m, p: string, v: string) => p + maskValue(v));
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
  "token",
  "access_token",
  "temp_token",
  "password",
  "secret",
  "client_secret",
  "auth_token",
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
  const maxArray = opts.maxArray ?? 500;
  const maxDepth = opts.maxDepth ?? 24;
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
  if (value instanceof Error) return { error: value.name, message: scrub(value.message) };
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

export type Dir = "in" | "out" | "note" | "error" | "http" | "result" | (string & {});

export interface LoggerOptions extends RedactOptions {
  dir?: string;
  /** Append to an existing file instead of truncating (default false). */
  append?: boolean;
  /** Also print a compact line per event to the console (redacted). Default false. */
  echo?: boolean;
}

export class JsonlLogger {
  readonly path: string;
  readonly test: string;
  readonly t0 = performance.now();
  private fd: number | null;
  private readonly opts: LoggerOptions;
  private tallies = new Map<string, { count: number; bytes: number; firstMs: number; lastMs: number }>();

  constructor(test: string, opts: LoggerOptions = {}) {
    registerFromProcessEnv();
    this.test = test;
    this.opts = opts;
    const dir = opts.dir ?? DEFAULT_OUT_DIR;
    mkdirSync(dir, { recursive: true });
    this.path = resolve(dir, `${test.replace(/[^\w.-]+/g, "_")}.jsonl`);
    this.fd = openSync(this.path, opts.append ? "a" : "w");
  }

  /** ms since logger creation (0.1 ms resolution). */
  elapsed(): number {
    return Math.round((performance.now() - this.t0) * 10) / 10;
  }

  /** Write one event. `data.type` (if any) is lifted to the top-level `type` field. */
  event(dir: Dir, data: unknown, extra: Record<string, unknown> = {}): void {
    const red = redact(data, this.opts);
    const type =
      red && typeof red === "object" && !Array.isArray(red) && typeof (red as { type?: unknown }).type === "string"
        ? (red as { type: string }).type
        : undefined;
    const line: Record<string, unknown> = { t: new Date().toISOString(), ms: this.elapsed(), dir };
    if (type) line.type = type;
    Object.assign(line, redact(extra, this.opts) as object);
    line.data = red;
    this.write(line);
    if (this.opts.echo) {
      const preview = JSON.stringify(red);
      console.log(`[${this.test}] +${line.ms}ms ${dir}${type ? ` ${type}` : ""} ${preview.length > 240 ? preview.slice(0, 240) + "..." : preview}`);
    }
  }

  /** Server -> client event. */
  in(data: unknown, extra?: Record<string, unknown>): void {
    this.event("in", data, extra);
  }
  /** Client -> server event. */
  out(data: unknown, extra?: Record<string, unknown>): void {
    this.event("out", data, extra);
  }
  note(msg: string, data?: unknown): void {
    this.event("note", data === undefined ? { msg } : { msg, ...(typeof data === "object" && data ? data : { value: data }) });
  }
  error(err: unknown, extra?: Record<string, unknown>): void {
    this.event("error", err instanceof Error ? { name: err.name, message: err.message, stack: err.stack?.split("\n").slice(0, 4).join(" | ") } : err, extra);
  }
  /** Final verdict for a test: PASS / FAIL / PARTIAL / SKIPPED. */
  result(status: "PASS" | "FAIL" | "PARTIAL" | "SKIPPED", details: Record<string, unknown> = {}): void {
    this.event("result", { status, ...details });
  }

  /**
   * Log a raw WebSocket message (as received from `ws`'s "message" event).
   * Text frames are JSON-parsed when possible; binary frames are summarized as {bytes}.
   */
  ws(dir: "in" | "out", raw: unknown, isBinary = false): unknown {
    if (isBinary) {
      this.event(dir, { binary: true, bytes: byteLength(raw) });
      return undefined;
    }
    if (raw !== null && typeof raw === "object" && !Buffer.isBuffer(raw) && !Array.isArray(raw) && !(raw instanceof ArrayBuffer)) {
      this.event(dir, raw); // already-parsed object (e.g. the payload you are about to JSON.stringify and send)
      return raw;
    }
    const text =
      typeof raw === "string"
        ? raw
        : Buffer.isBuffer(raw)
          ? raw.toString("utf8")
          : Array.isArray(raw)
            ? Buffer.concat(raw as Buffer[]).toString("utf8")
            : raw instanceof ArrayBuffer
              ? Buffer.from(raw).toString("utf8")
              : String(raw);
    try {
      const parsed = JSON.parse(text) as unknown;
      this.event(dir, parsed);
      return parsed;
    } catch {
      this.event(dir, { text });
      return text;
    }
  }

  /**
   * Count high-volume audio frames without writing a line per frame. Call `flushTallies()`
   * (or `close()`) to emit one summary line per key.
   */
  tally(key: string, bytes: number): void {
    const now = this.elapsed();
    const t = this.tallies.get(key) ?? { count: 0, bytes: 0, firstMs: now, lastMs: now };
    t.count++;
    t.bytes += bytes;
    t.lastMs = now;
    this.tallies.set(key, t);
  }
  flushTallies(): void {
    for (const [key, t] of this.tallies) this.event("note", { msg: "tally", key, ...t });
    this.tallies.clear();
  }

  close(): void {
    if (this.fd === null) return;
    this.flushTallies();
    closeSync(this.fd);
    this.fd = null;
  }

  private write(obj: unknown): void {
    if (this.fd === null) throw new Error(`logger ${this.test} is closed`);
    writeSync(this.fd, JSON.stringify(obj) + "\n");
  }
}

function byteLength(raw: unknown): number {
  if (raw instanceof ArrayBuffer) return raw.byteLength;
  if (ArrayBuffer.isView(raw)) return raw.byteLength;
  if (Array.isArray(raw)) return raw.reduce((a: number, b: unknown) => a + byteLength(b), 0);
  if (typeof raw === "string") return Buffer.byteLength(raw);
  return 0;
}

export const createLogger = (test: string, opts?: LoggerOptions): JsonlLogger => new JsonlLogger(test, opts);

// ---------------------------------------------------------------------------------------------
// fetch wrapper that logs request + response (redacted) with timing
// ---------------------------------------------------------------------------------------------

export interface LoggedResponse<T = unknown> {
  status: number;
  ok: boolean;
  ms: number;
  headers: Record<string, string>;
  json: T | undefined;
  text: string;
}

/** fetch() + log {method, url, headers(masked), body} and {status, ms, headers, body}. Body is read as text. */
export async function loggedFetch<T = unknown>(log: JsonlLogger, url: string, init: RequestInit & { label?: string } = {}): Promise<LoggedResponse<T>> {
  const { label, ...req } = init;
  let reqBody: unknown = req.body;
  if (typeof req.body === "string") {
    try {
      reqBody = JSON.parse(req.body);
    } catch {
      /* keep text */
    }
  }
  log.event("http", { phase: "request", label, method: req.method ?? "GET", url, headers: req.headers ?? {}, body: reqBody });
  const t = performance.now();
  const res = await fetch(url, req);
  const text = await res.text();
  const ms = Math.round(performance.now() - t);
  let json: T | undefined;
  try {
    json = text ? (JSON.parse(text) as T) : undefined;
  } catch {
    json = undefined;
  }
  const headers = Object.fromEntries(res.headers.entries());
  log.event("http", { phase: "response", label, status: res.status, ms, headers, body: json ?? text });
  return { status: res.status, ok: res.ok, ms, headers, json, text };
}

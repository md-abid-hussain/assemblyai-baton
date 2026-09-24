import { afterEach, describe, expect, it } from "vitest";

import { fillSecrets, GENERATED_SECRETS } from "../../../scripts/gen-secrets";
import { parseDotEnv } from "../../../scripts/lib/load-env";
import { EnvError, parseEnv } from "../../../src/server/env";
import { createLogger, redact, registerSecrets, scrub, setLogSink } from "../../../src/server/log";

describe("env()", () => {
  it("applies DESIGN §3.4 defaults and treats empty strings as unset", () => {
    const e = parseEnv({ DATABASE_URL: "postgres://u:p@h:5432/db", POLAR_WEBHOOK_SECRET: "", VA_KEYTERMS: "1" });
    expect(e.STT_OPENS_PER_MIN).toBe(4);
    expect(e.VA_MAX_CONCURRENT).toBe(3);
    expect(e.VA_SESSION_CAP_MAX_MS).toBe(420_000);
    expect(e.POLAR_SERVER).toBe("sandbox");
    expect(e.PAYMENTS_MODE).toBe("mock");
    expect(e.POLAR_WEBHOOK_SECRET).toBeUndefined();
    expect(e.VA_KEYTERMS).toBe(true);
    expect(e.FEATURE_BE_CUSTOMER).toBe(false);
    expect(e.BATON_DEPLOY_ID).toBe("dev-local");
  });

  it("parses lists and JSON records", () => {
    const e = parseEnv({ EMBED_ORIGINS: "https://a.zerops.app, https://b.vercel.app", POLAR_DEMO_CUSTOMERS: '{"s01":"c1"}' });
    expect(e.EMBED_ORIGINS).toEqual(["https://a.zerops.app", "https://b.vercel.app"]);
    expect(e.POLAR_DEMO_CUSTOMERS).toEqual({ s01: "c1" });
  });

  it("names invalid variables without echoing their values", () => {
    const secretish = "sk-live-THIS-MUST-NOT-APPEAR";
    let err: unknown;
    try {
      parseEnv({ LIMITS_ROLE: secretish, VA_MAX_CONCURRENT: "many" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(EnvError);
    const msg = (err as Error).message;
    expect(msg).toContain("LIMITS_ROLE");
    expect(msg).toContain("VA_MAX_CONCURRENT");
    expect(msg).not.toContain(secretish);
    expect(msg).not.toContain("many");
  });
});

describe("log", () => {
  let restore: (() => void) | null = null;
  afterEach(() => restore?.());

  it("masks registered secrets, sensitive keys, token params, JWTs and URL passwords", () => {
    const secret = "aai_0123456789abcdef0123456789";
    registerSecrets(secret);
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjYXNlXzEyMyJ9.c2lnbmF0dXJlLXNpZ25hdHVyZQ";
    const lines: string[] = [];
    restore = setLogSink((_l, line) => lines.push(line));
    createLogger({ component: "t" }).info(`key ${secret}`, {
      authorization: `Bearer ${secret}`,
      url: `wss://streaming.assemblyai.com/v3/ws?token=${"t".repeat(40)}&sample_rate=8000`,
      jwt,
      db: "postgres://postgres:hunter2hunter2@localhost:5432/db",
      nested: { deep: [secret] },
    });
    const out = lines.join("\n");
    expect(out).not.toContain(secret);
    expect(out).not.toContain("t".repeat(40));
    expect(out).not.toContain(jwt);
    expect(out).not.toContain("hunter2hunter2");
    expect(out).toContain("sample_rate=8000");
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: "info", component: "t" });
  });

  it("summarises audio payloads and binary data as byte counts", () => {
    const r = redact({ audio: "A".repeat(4000), buf: new Uint8Array(320) }) as Record<string, unknown>;
    expect(r.audio).toEqual({ bytes: 3000 });
    expect(r.buf).toEqual({ bytes: 320 });
    expect(scrub("plain text")).toBe("plain text");
  });
});

describe("secrets:init (fillSecrets)", () => {
  const gen = (() => {
    let i = 0;
    return () => `GENERATED_${++i}_xxxxxxxxxxxxxxxx`;
  })();

  it("appends missing names, fills empty ones in place, never overwrites existing values", () => {
    const original = ["# header", "ASSEMBLYAI_API_KEY=existing-aai-key-value", "ADMIN_KEY=", "CRON_SECRET=keep-me-please-123", "TWILIO_PHONE_NUMBER=   # E.164", ""].join("\n");
    const r = fillSecrets(original, gen);
    expect(r.kept).toEqual(["CRON_SECRET"]);
    expect(r.filled).toEqual(["ADMIN_KEY"]);
    expect(r.added).toEqual(GENERATED_SECRETS.filter((n) => n !== "CRON_SECRET" && n !== "ADMIN_KEY"));
    expect(r.text).toContain("ASSEMBLYAI_API_KEY=existing-aai-key-value");
    expect(r.text).toContain("CRON_SECRET=keep-me-please-123");
    expect(r.text).toContain("TWILIO_PHONE_NUMBER=   # E.164");
    expect(r.text.split("\n")[2]).toMatch(/^ADMIN_KEY=GENERATED_/);
    const parsed = parseDotEnv(r.text);
    for (const n of GENERATED_SECRETS) expect(parsed[n]).toBeTruthy();
    expect(r.externalMissing).toContain("OPENAI_API_KEY");
  });

  it("is idempotent", () => {
    const once = fillSecrets("", gen).text;
    const twice = fillSecrets(once, gen);
    expect(twice.added).toEqual([]);
    expect(twice.filled).toEqual([]);
    expect(twice.text).toBe(once);
  });

  it("keeps CRLF line endings", () => {
    const r = fillSecrets("A=1\r\nB=2\r\n", gen);
    expect(r.text.includes("\r\n")).toBe(true);
    expect(r.text.replace(/\r\n/g, "")).not.toContain("\n");
  });
});

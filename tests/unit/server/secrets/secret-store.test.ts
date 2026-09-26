/**
 * WP16 acceptance 5 (secrets): AES-256-GCM at rest with the HKDF(AGENT_TOOL_SECRET) key (Q7 default) or
 * CONNECTOR_SECRETS_KEY; values never returned by list/put, never in rows, never in any log line (log capture);
 * 7-day expiry; ≤ 10 per workspace; a value resolves only in its own workspace (the relay owner's); AAD binding;
 * key rotation reads as missing. Plus the Postgres repos against the 0001 DDL when a local DB is available.
 */
import { hkdfSync } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SecretRefSchema } from "@/core/contracts/v2/blueprint";
import { PgConnectorCallLog } from "@/server/connectors/call-log";
import { ConnectorError } from "@/server/connectors/errors";
import { executeHttpAction } from "@/server/connectors/http";
import { EnvError } from "@/server/env";
import { log, setLogSink } from "@/server/log";
import {
  deriveSecretsKey, KEY_VERSION_DERIVED, KEY_VERSION_EXPLICIT, openSecret, sealSecret, secretAad, secretKeyringFromEnv,
} from "@/server/secrets/crypto";
import { MemorySecretRepo, PgSecretRepo } from "@/server/secrets/repo";
import { ConnectorSecretStore, MAX_SECRETS_PER_WORKSPACE, newSecretId, SECRET_TTL_MS, SecretError } from "@/server/secrets/store";
import { createTestDb, HAS_DB, type TestDb } from "../cases/helpers/test-db";

const IKM = "agent-tool-secret-for-unit-tests-only-0123456789";
const VALUE = "demo-secret-value-4eC39HqLyjWDar";
const ring = () => secretKeyringFromEnv({ AGENT_TOOL_SECRET: IKM });

function store(clock = { t: Date.parse("2026-09-25T10:00:00Z") }, repo = new MemorySecretRepo()) {
  return { s: new ConnectorSecretStore({ repo, keyring: ring, clock: () => clock.t }), repo, clock };
}

async function missing(p: Promise<unknown>): Promise<boolean> {
  try {
    await p;
    return false;
  } catch (e) {
    return e instanceof ConnectorError && e.code === "E_CONN_SECRET_MISSING";
  }
}

describe("key derivation (PLATFORM §6.4, Q7)", () => {
  it("derives HKDF-SHA256(ikm=AGENT_TOOL_SECRET, salt='changeover', info='connector-secrets/v1'), 32 bytes", () => {
    const expected = Buffer.from(hkdfSync("sha256", IKM, "changeover", "connector-secrets/v1", 32));
    expect(deriveSecretsKey(IKM).equals(expected)).toBe(true);
    const r = ring();
    expect(r.current).toBe(KEY_VERSION_DERIVED);
    expect(r.keys.get(KEY_VERSION_DERIVED)!.equals(expected)).toBe(true);
  });

  it("prefers CONNECTOR_SECRETS_KEY (32 bytes base64) and keeps the derived key for old rows", () => {
    const explicit = Buffer.alloc(32, 7).toString("base64");
    const r = secretKeyringFromEnv({ AGENT_TOOL_SECRET: IKM, CONNECTOR_SECRETS_KEY: explicit });
    expect(r.current).toBe(KEY_VERSION_EXPLICIT);
    expect([...r.keys.keys()].sort()).toEqual([1, 2]);
  });

  it("names (never prints) a missing or invalid key", () => {
    expect(() => secretKeyringFromEnv({})).toThrow(EnvError);
    try {
      secretKeyringFromEnv({ CONNECTOR_SECRETS_KEY: "dG9vLXNob3J0" });
    } catch (e) {
      expect(e).toBeInstanceOf(EnvError);
      expect((e as Error).message).toContain("CONNECTOR_SECRETS_KEY");
      expect((e as Error).message).not.toContain("dG9vLXNob3J0");
    }
  });

  it("AES-256-GCM with a random 12-byte IV; the AAD binds workspace and name", () => {
    const r = ring();
    const a = sealSecret(r, VALUE, secretAad("ws_a", "stripe"));
    const b = sealSecret(r, VALUE, secretAad("ws_a", "stripe"));
    expect(a.iv).toHaveLength(12);
    expect(a.tag).toHaveLength(16);
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.includes(Buffer.from(VALUE))).toBe(false);
    expect(openSecret(r, a, secretAad("ws_a", "stripe"))).toBe(VALUE);
    expect(openSecret(r, a, secretAad("ws_b", "stripe"))).toBeNull();
    expect(openSecret(r, a, secretAad("ws_a", "other"))).toBeNull();
    expect(openSecret(r, { ...a, tag: Buffer.alloc(16) }, secretAad("ws_a", "stripe"))).toBeNull();
    expect(openSecret(secretKeyringFromEnv({ AGENT_TOOL_SECRET: "rotated-ikm-0123456789" }), a, secretAad("ws_a", "stripe"))).toBeNull();
  });
});

describe("ConnectorSecretStore", () => {
  it("put returns metadata only; list shows names only; resolve gives the value back", async () => {
    const { s, repo } = store();
    const meta = await s.put("ws_a", "stripe_test", VALUE);
    expect(SecretRefSchema.safeParse({ $secret: meta.id }).success).toBe(true);
    expect(meta).toEqual({ id: meta.id, name: "stripe_test", createdAt: "2026-09-25T10:00:00.000Z", expiresAt: "2026-10-02T10:00:00.000Z" });
    expect(JSON.stringify(await s.list("ws_a"))).not.toContain(VALUE);
    expect(await s.resolve("ws_a", { $secret: meta.id })).toBe(VALUE);
    for (const row of repo.dump()) {
      expect(row.ciphertext.includes(Buffer.from(VALUE))).toBe(false);
      expect(JSON.stringify(row)).not.toContain(VALUE);
    }
  });

  it("resolves only in the owner's workspace (a visitor workspace cannot read the owner's secret)", async () => {
    const { s } = store();
    const meta = await s.put("ws_owner", "api_key", VALUE);
    expect(await missing(s.resolve("ws_visitor", { $secret: meta.id }))).toBe(true);
    expect(await s.resolve("ws_owner", { $secret: meta.id })).toBe(VALUE);
    expect(await missing(s.resolve("ws_owner", { $secret: "sec_0000000000000000" }))).toBe(true);
  });

  it("expires after 7 days (resolve → E_CONN_SECRET_MISSING; list drops it)", async () => {
    const { s, clock } = store();
    const meta = await s.put("ws_a", "k", VALUE);
    clock.t += SECRET_TTL_MS - 1;
    expect(await s.resolve("ws_a", { $secret: meta.id })).toBe(VALUE);
    clock.t += 1;
    expect(await missing(s.resolve("ws_a", { $secret: meta.id }))).toBe(true);
    expect(await s.list("ws_a")).toEqual([]);
    expect(await s.purgeExpired()).toBe(1);
  });

  it("re-putting a name replaces the value, keeps the id and restarts the expiry", async () => {
    const { s, clock } = store();
    const first = await s.put("ws_a", "k", VALUE);
    clock.t += 60_000;
    const second = await s.put("ws_a", "k", "new-value-0123456789");
    expect(second.id).toBe(first.id);
    expect(Date.parse(second.expiresAt)).toBe(clock.t + SECRET_TTL_MS);
    expect(await s.resolve("ws_a", { $secret: first.id })).toBe("new-value-0123456789");
    expect(await s.list("ws_a")).toHaveLength(1);
  });

  it("≤ 10 live secrets per workspace (E_SECRET_LIMIT); replacing an existing name is fine; ≤ 1 KiB values", async () => {
    const { s } = store();
    for (let i = 0; i < MAX_SECRETS_PER_WORKSPACE; i++) await s.put("ws_a", `k${i}`, `value-${i}-0123456789`);
    await expect(s.put("ws_a", "k10", "x")).rejects.toMatchObject({ code: "E_SECRET_LIMIT" });
    await expect(s.put("ws_a", "k3", "replaced")).resolves.toMatchObject({ name: "k3" });
    await expect(s.put("ws_b", "k10", "x")).resolves.toMatchObject({ name: "k10" });
    await expect(s.put("ws_c", "big", "x".repeat(1025))).rejects.toBeInstanceOf(SecretError);
    await expect(s.put("ws_c", "bad name!", "x")).rejects.toBeInstanceOf(SecretError);
    await expect(s.put("ws_c", "empty", "")).rejects.toBeInstanceOf(SecretError);
  });

  it("a key change reads as missing, never as garbage", async () => {
    const repo = new MemorySecretRepo();
    const clock = { t: Date.now() };
    const a = new ConnectorSecretStore({ repo, keyring: ring, clock: () => clock.t });
    const meta = await a.put("ws_a", "k", VALUE);
    const b = new ConnectorSecretStore({ repo, keyring: () => secretKeyringFromEnv({ AGENT_TOOL_SECRET: "a-different-ikm-0123456789" }), clock: () => clock.t });
    expect(await missing(b.resolve("ws_a", { $secret: meta.id }))).toBe(true);
  });

  it("ids are sec_ + 16 [a-z0-9]", () => {
    for (let i = 0; i < 50; i++) expect(newSecretId()).toMatch(/^sec_[a-z0-9]{16}$/);
  });
});

describe("log capture: a secret value never reaches a log line", () => {
  it("across put, list, resolve, a failing and a succeeding connector call, and error paths", async () => {
    const lines: string[] = [];
    const restore = setLogSink((_l, line) => lines.push(line));
    try {
      const { s } = store();
      const meta = await s.put("ws_a", "api_key", VALUE);
      const value = await s.resolve("ws_a", { $secret: meta.id });
      log.info("resolved a secret", { value, meta, headers: { Authorization: `Bearer ${value}` } });
      log.error("oops", new Error(`failed with ${value}`));
      const report = await executeHttpAction({
        url: "https://127.0.0.1/", method: "POST", toolName: "t", args: {}, run: { relay: "r", version: 1, case: null, mode: "console" },
        headers: [{ name: "Authorization", value: `Bearer ${value}`, secretName: "api_key" }], hmac: { name: "api_key", value },
        timeoutMs: 1000, responsePick: [],
      }, { policy: { enforceAllowlist: false, hosts: [] } });
      log.warn("connector call", { report });
      expect(JSON.stringify(report)).not.toContain(VALUE);
      expect(lines.length).toBeGreaterThanOrEqual(3);
      for (const line of lines) expect(line).not.toContain(VALUE);
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------------------------------- Postgres

/** PLATFORM §2.4 DDL (WP14b's migration 0001 creates these; IF NOT EXISTS so it coexists once 0001 lands). */
const DDL = `
CREATE TABLE IF NOT EXISTS connector_secrets (
  id text PRIMARY KEY, workspace_id text NOT NULL, name text NOT NULL,
  ciphertext bytea NOT NULL, iv bytea NOT NULL, tag bytea NOT NULL, key_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
  UNIQUE (workspace_id, name));
CREATE TABLE IF NOT EXISTS connector_calls (
  id text PRIMARY KEY, case_id text, takeover_id text, relay_version_id text, publication_id text,
  connector_id text NOT NULL, tool_name text NOT NULL, mode text NOT NULL, status text NOT NULL,
  http_status integer, ms integer NOT NULL, req_bytes integer NOT NULL DEFAULT 0, res_bytes integer NOT NULL DEFAULT 0,
  args_hash text, result jsonb, error_code text, created_at timestamptz NOT NULL DEFAULT now());
`;

describe.skipIf(!HAS_DB)("Postgres repos (0001 tables)", () => {
  let tdb: TestDb;
  beforeAll(async () => {
    tdb = await createTestDb("wp16sec");
    await tdb.pool.query(DDL);
  }, 60_000);
  afterAll(async () => {
    await tdb?.drop();
  });

  it("PgSecretRepo: put/resolve/list/expiry/replace-keeps-id/remove, ciphertext only at rest", async () => {
    const clock = { t: Date.parse("2026-09-25T10:00:00Z") };
    const s = new ConnectorSecretStore({ repo: new PgSecretRepo(tdb.pool), keyring: ring, clock: () => clock.t });
    const meta = await s.put("ws_pg", "api_key", VALUE);
    expect(await s.resolve("ws_pg", { $secret: meta.id })).toBe(VALUE);
    expect(await missing(s.resolve("ws_other", { $secret: meta.id }))).toBe(true);
    const again = await s.put("ws_pg", "api_key", "second-value-0123456789");
    expect(again.id).toBe(meta.id);
    expect(await s.resolve("ws_pg", { $secret: meta.id })).toBe("second-value-0123456789");
    const raw = await tdb.pool.query("select * from connector_secrets");
    expect(JSON.stringify(raw.rows)).not.toContain("second-value");
    expect(raw.rows[0].ciphertext.includes(Buffer.from("second-value-0123456789"))).toBe(false);
    expect(await s.list("ws_pg")).toHaveLength(1);
    clock.t += SECRET_TTL_MS;
    expect(await s.list("ws_pg")).toEqual([]);
    expect(await missing(s.resolve("ws_pg", { $secret: meta.id }))).toBe(true);
    expect(await s.purgeExpired()).toBe(1);
    const m2 = await s.put("ws_pg", "k2", VALUE);
    await s.remove("ws_pg", m2.id);
    expect(await s.list("ws_pg")).toEqual([]);
  });

  it("PgConnectorCallLog: record + findRecent (dedupe window, ok only)", async () => {
    const logRepo = new PgConnectorCallLog(tdb.pool);
    const t = Date.now();
    const base = {
      caseId: "c1", takeoverId: "tk_pg", relayVersionId: "rv_1", publicationId: null, connectorId: "pay", toolName: "send_link",
      mode: "live" as const, httpStatus: 200, ms: 12.7, reqBytes: 10, resBytes: 20, argsHash: "h", errorCode: null,
    };
    const row = await logRepo.record({ ...base, status: "ok", result: { data: { a: 1 }, http_status: 200 }, createdAt: new Date(t - 1000) });
    expect(row).toMatchObject({ ms: 13, result: { data: { a: 1 }, http_status: 200 } });
    await logRepo.record({ ...base, status: "error", result: null, errorCode: "E_CONN_TIMEOUT", createdAt: new Date(t) });
    const hit = await logRepo.findRecent({ takeoverId: "tk_pg", toolName: "send_link", argsHash: "h", since: new Date(t - 30_000) });
    expect(hit?.id).toBe(row.id);
    expect(await logRepo.findRecent({ takeoverId: "tk_pg", toolName: "send_link", argsHash: "h", since: new Date(t - 500) })).toBeNull();
  });
});

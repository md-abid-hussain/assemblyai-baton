import "server-only";

import { randomBytes } from "node:crypto";

import { ID_PREFIXES, type SecretMeta } from "@/core/contracts/v2/api";
import type { SecretRef } from "@/core/contracts/v2/blueprint";
import type { SecretStore } from "@/core/contracts/v2/services";
import { ConnectorError } from "../connectors/errors";
import { registerSecrets } from "../log";
import { openSecret, sealSecret, secretAad, secretKeyringFromEnv, type SecretKeyring } from "./crypto";
import type { SecretRepo, SecretRow } from "./repo";

/**
 * `SecretStore` (contracts/v2/services.ts; PLATFORM §6.4). Server-only; a value is never serialised.
 *
 * - `put(ws, name, value)`: value ≤ 1 KiB, name `[A-Za-z0-9_-]{1,40}`, ≤ 10 live secrets per workspace
 *   (`E_SECRET_LIMIT`). Re-putting a name replaces its value and KEEPS its `sec_…` id (blueprint refs stay valid);
 *   every put restarts the 7-day expiry.
 * - `list(ws)`: metadata of live secrets only (names, never values).
 * - `resolve(ws, ref)`: the plaintext for the connector runtime, looked up in THE GIVEN workspace only (callers pass
 *   the relay owner's, never a visitor's: PLATFORM §6.2 "Whose secrets"). Missing, expired, foreign or undecryptable →
 *   `ConnectorError("E_CONN_SECRET_MISSING")`.
 * Values are also registered with the log scrubber, so even an accidental log line masks them.
 */

export const SECRET_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_SECRETS_PER_WORKSPACE = 10;
export const MAX_SECRET_VALUE_BYTES = 1024;
/**
 * WP16·3: `expires_at` is NOT NULL, so a plan with no secret expiry (Pro, Business; SAAS §4.1) stores a date far
 * past the demo's life rather than a null. Nothing reads it except the "expired?" comparison and the purge job.
 */
export const NO_EXPIRY_MS = 100 * 365 * 24 * 60 * 60 * 1000;
const NAME_RE = /^[A-Za-z0-9_-]{1,40}$/;
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export class SecretError extends Error {
  constructor(readonly code: "E_SECRET_LIMIT" | "E_BAD_REQUEST", message: string) {
    super(message);
    this.name = "SecretError";
  }
}

/** Recognised by name + code, never by `instanceof` alone (see `isBatonError`; QA-FIX). */
export const isSecretError = (e: unknown): e is SecretError => {
  if (e instanceof SecretError) return true;
  if (typeof e !== "object" || e === null) return false;
  const { name, code, message } = e as { name?: unknown; code?: unknown; message?: unknown };
  return name === "SecretError" && typeof message === "string" && (code === "E_SECRET_LIMIT" || code === "E_BAD_REQUEST");
};

/** `sec_` + 16 chars of [a-z0-9] (the `SecretRefSchema` shape), unbiased. */
export function newSecretId(): string {
  let out = "";
  while (out.length < 16) {
    for (const b of randomBytes(24)) {
      if (b < 252 && out.length < 16) out += ID_ALPHABET[b % 36];
    }
  }
  return `${ID_PREFIXES.secret}${out}`;
}

const meta = (r: SecretRow): SecretMeta => ({
  id: r.id, name: r.name, createdAt: r.createdAt.toISOString(), expiresAt: r.expiresAt.toISOString(),
});

/** What a workspace's plan allows (SAAS §4.1). `ttlMs: null` = the secrets do not expire. */
export interface SecretPlanLimits {
  maxSecrets: number;
  ttlMs: number | null;
}

export interface SecretStoreDeps {
  repo: SecretRepo;
  /** Lazily read so a deploy without AGENT_TOOL_SECRET still boots (EnvError on first use, names only). */
  keyring?: () => SecretKeyring;
  clock?: () => number;
  newId?: () => string;
  /**
   * WP16·3: the plan's secret count and TTL for this workspace (SAAS §4.1). Default: the v2 constants (10 / 7
   * days), so every pre-SaaS caller and test behaves exactly as before. The route ALSO asks
   * `Entitlements.assertCount`, which produces the 402 with the upgrade message; this is the store's own hard
   * stop, so a caller that skips the route can never exceed the plan either.
   */
  plan?: (ws: string) => Promise<SecretPlanLimits>;
}

export class ConnectorSecretStore implements SecretStore {
  private readonly repo: SecretRepo;
  private readonly clock: () => number;
  private readonly newId: () => string;
  private ringCache: SecretKeyring | null = null;
  private readonly ringFactory: () => SecretKeyring;
  private readonly planOf: (ws: string) => Promise<SecretPlanLimits>;

  constructor(deps: SecretStoreDeps) {
    this.repo = deps.repo;
    this.clock = deps.clock ?? Date.now;
    this.newId = deps.newId ?? newSecretId;
    this.ringFactory = deps.keyring ?? (() => secretKeyringFromEnv());
    this.planOf = deps.plan ?? (async () => ({ maxSecrets: MAX_SECRETS_PER_WORKSPACE, ttlMs: SECRET_TTL_MS }));
  }

  private ring(): SecretKeyring {
    return (this.ringCache ??= this.ringFactory());
  }

  async put(ws: string, name: string, value: string): Promise<SecretMeta> {
    if (!NAME_RE.test(name)) throw new SecretError("E_BAD_REQUEST", "A secret name is 1–40 letters, digits, '-' or '_'.");
    if (value.length === 0 || Buffer.byteLength(value, "utf8") > MAX_SECRET_VALUE_BYTES) {
      throw new SecretError("E_BAD_REQUEST", `A secret value is 1–${MAX_SECRET_VALUE_BYTES} bytes.`);
    }
    const now = new Date(this.clock());
    const limits = await this.planOf(ws);
    const existing = await this.repo.getByName(ws, name);
    if (!existing) {
      const live = await this.repo.listLive(ws, now);
      if (live.length >= limits.maxSecrets) {
        throw new SecretError("E_SECRET_LIMIT", `This workspace's plan holds ${limits.maxSecrets} secrets; delete one first, or upgrade.`);
      }
    }
    registerSecrets(value);
    const sealed = sealSecret(this.ring(), value, secretAad(ws, name));
    const row = await this.repo.upsert({
      id: existing?.id ?? this.newId(), workspaceId: ws, name, ...sealed,
      createdAt: now, expiresAt: new Date(now.getTime() + (limits.ttlMs ?? NO_EXPIRY_MS)),
    });
    return meta(row);
  }

  async list(ws: string): Promise<SecretMeta[]> {
    return (await this.repo.listLive(ws, new Date(this.clock()))).map(meta);
  }

  async remove(ws: string, id: string): Promise<void> {
    await this.repo.remove(ws, id);
  }

  async resolve(ws: string, ref: SecretRef): Promise<string> {
    const row = await this.repo.getById(ws, ref.$secret);
    if (!row || row.expiresAt.getTime() <= this.clock()) {
      throw new ConnectorError("E_CONN_SECRET_MISSING", "A secret this connector needs is not set or has expired; set it again on the Connectors tab.");
    }
    const value = openSecret(this.ring(), row, secretAad(ws, row.name));
    if (value === null) {
      throw new ConnectorError("E_CONN_SECRET_MISSING", "A secret this connector needs can no longer be read (the key changed); set it again.");
    }
    registerSecrets(value);
    return value;
  }

  /** The secret's display name (for `‹secret:name›` in the console), or null. Never the value. */
  async nameOf(ws: string, ref: SecretRef): Promise<string | null> {
    return (await this.repo.getById(ws, ref.$secret))?.name ?? null;
  }

  /** Delete expired rows (called by the purge job). */
  async purgeExpired(): Promise<number> {
    return this.repo.purgeExpired(new Date(this.clock()));
  }
}

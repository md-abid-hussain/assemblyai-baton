/**
 * WP19·1: the rest of contracts v3 against SAAS §14 — the error status map (§6.3), the audit vocabulary (§9),
 * the event envelope and payloads (§7.1), the relay-code shapes (§5.3) and the frozen `/api/v1` schema names (§6.2).
 *
 * These names freeze at C3. `public-api.ts` moves to WP22, which fills its fields in **additively**, so this file
 * pins the names and the conventions rather than every field.
 */
import { describe, expect, it } from "vitest";

import { AUDIT_ACTIONS, AUDIT_SOURCE_SAVED_COALESCE_MS, type AuditEntry } from "@/core/contracts/v3/audit";
import { V3_ERROR_CODES, V3_ERROR_STATUS, isV3ErrorCode } from "@/core/contracts/v3/errors";
import {
  DOMAIN_EVENT_TYPES, EVENT_API_VERSION, EVENT_DATA_SCHEMAS, EventEnvelope, RunCompletedData, WebhookTestData,
} from "@/core/contracts/v3/events";
import { CODEC_CODES, MAX_SOURCE_BYTES } from "@/core/contracts/v3/relay-code";
import * as publicApi from "@/core/contracts/v3/public-api";
import { PAGE_LIMIT_DEFAULT, PAGE_LIMIT_MAX, PageOf, PUBLIC_API_VERSION } from "@/core/contracts/v3/public-api";
import { z } from "zod";

describe("SAAS §14 errors.ts", () => {
  it("is exactly the §14 status map", () => {
    expect(V3_ERROR_STATUS).toEqual({
      E_AUTH_REQUIRED: 401, E_ACCOUNT_REQUIRED: 403, E_FORBIDDEN: 403, E_SCOPE: 403, E_CSRF: 403,
      E_USE_APP_API: 403, E_NOT_FOUND: 404, E_CONFLICT: 409, E_VALIDATION: 400, E_UNPROCESSABLE: 422,
      E_PLAN_LIMIT: 402, E_RATE_LIMITED: 429, E_BUSY: 503, E_BILLING_UNAVAILABLE: 503,
    });
  });

  // §14's code block predates the v3.1 review; §6.4/§10.4/§17-I3 added the shed code. C3 syncs the map.
  it("carries E_BUSY for the global compile bucket's 503 shed (§6.4, §10.4)", () => {
    expect(V3_ERROR_STATUS.E_BUSY).toBe(503);
    expect(isV3ErrorCode("E_BUSY")).toBe(true);
  });

  it("a plan limit is 402 and a foreign id is 404, never 403 (no existence leak)", () => {
    expect(V3_ERROR_STATUS.E_PLAN_LIMIT).toBe(402);
    expect(V3_ERROR_STATUS.E_NOT_FOUND).toBe(404);
  });

  it("isV3ErrorCode narrows only real codes", () => {
    expect(V3_ERROR_CODES.every(isV3ErrorCode)).toBe(true);
    expect(isV3ErrorCode("E_BUDGET")).toBe(false); // a v1 code: a different envelope, a different map
    expect(isV3ErrorCode("toString")).toBe(false);
  });
});

describe("SAAS §9 audit.ts", () => {
  it("lists exactly the §9 actions, with no duplicates", () => {
    expect(new Set(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length);
    expect([...AUDIT_ACTIONS]).toEqual([
      "org.created", "org.renamed", "org.deleted", "org.ownership_transferred",
      "member.invited", "member.invite_revoked", "member.joined", "member.role_changed", "member.removed", "member.left",
      "guest.claimed", "guest.claimed_device",
      "relay.created", "relay.cloned", "relay.imported", "relay.source_saved", "relay.deleted",
      "relay.version_created", "relay.restored", "relay.published", "relay.unpublished",
      "secret.created", "secret.deleted",
      "connector.tested", "connector.host_added", "connector.host_removed",
      "apikey.created", "apikey.revoked", "apikey.disabled",
      "webhook.endpoint_created", "webhook.endpoint_updated", "webhook.endpoint_deleted",
      "webhook.endpoint_disabled", "webhook.redelivered", "webhook.test_sent",
      "billing.checkout_started", "billing.plan_changed", "billing.canceled", "billing.resumed",
      "entitlement.override_set",
      "session.signed_in",
    ]);
  });

  it("covers every actor type and allows a null org", () => {
    const entry: AuditEntry = { orgId: null, actor: { type: "system", id: null, label: "cron" }, action: "org.deleted" };
    expect(entry.orgId).toBeNull();
  });

  it("coalesces Studio source saves at 10 minutes", () => {
    expect(AUDIT_SOURCE_SAVED_COALESCE_MS).toBe(600_000);
  });
});

describe("SAAS §7.1 events.ts", () => {
  it("has exactly the four event types and the frozen api_version", () => {
    expect([...DOMAIN_EVENT_TYPES]).toEqual(["run.completed", "case.verified", "payment.succeeded", "webhook.test"]);
    expect(EVENT_API_VERSION).toBe("2026-09-25");
    expect(Object.keys(EVENT_DATA_SCHEMAS)).toEqual([...DOMAIN_EVENT_TYPES]);
  });

  it("the envelope parses the §7.1 example", () => {
    const parsed = EventEnvelope.parse({
      id: "evt_1", type: "run.completed", created_at: "2026-09-27T10:12:03Z", org_id: "org_1",
      api_version: "2026-09-25", data: {},
    });
    expect(parsed.type).toBe("run.completed");
    expect(EventEnvelope.safeParse({ id: "evt_1", type: "run.completed", created_at: "x", org_id: "o", api_version: "2025-01-01", data: {} }).success).toBe(false);
    expect(EventEnvelope.safeParse({ id: "evt_1", type: "run.started", created_at: "x", org_id: "o", api_version: EVENT_API_VERSION, data: {} }).success).toBe(false);
  });

  it("run.completed is thin: ids, statuses and numbers only", () => {
    const data = {
      run_id: "case_1", relay_id: "rl_1", relay_version: 3, source: "recorded", outcome: "completed",
      stages_reached: ["collect", "pay"], ai_seconds: 42, payment_status: "succeeded",
      started_at: "2026-09-27T10:00:00Z", passed_at: "2026-09-27T10:01:00Z", ended_at: "2026-09-27T10:12:00Z",
      links: { run: "https://app/run/1", api: "https://app/api/v1/runs/1" },
    };
    const out = RunCompletedData.parse(data);
    expect(out.ai_seconds).toBe(42);
    // Transcript text and field values are not part of the schema, so they are stripped rather than forwarded.
    expect(Object.keys(RunCompletedData.parse({ ...data, transcript: "hello", customer_email: "a@b.c" }))).not.toContain("transcript");
    expect(Object.keys(RunCompletedData.parse({ ...data, transcript: "hello" }))).not.toContain("customer_email");
  });

  it("a nullable relay id and version are allowed (a Baton run has no relay)", () => {
    const base = {
      run_id: "case_1", relay_id: null, relay_version: null, source: "replay", outcome: "handed_back",
      stages_reached: [], ai_seconds: 0, payment_status: "none", started_at: "t", passed_at: null, ended_at: "t",
      links: { run: "r", api: "a" },
    };
    expect(RunCompletedData.safeParse(base).success).toBe(true);
  });

  it("webhook.test carries the fixed message", () => {
    expect(WebhookTestData.safeParse({ message: "Hello from Changeover", endpoint_id: "we_1" }).success).toBe(true);
    expect(WebhookTestData.safeParse({ message: "hi", endpoint_id: "we_1" }).success).toBe(false);
  });
});

describe("SAAS §5.3 relay-code.ts", () => {
  it("caps a source body at 256 KiB and names the five codec codes", () => {
    expect(MAX_SOURCE_BYTES).toBe(262_144);
    expect([...CODEC_CODES]).toEqual(["CODEC_SYNTAX", "CODEC_UNKNOWN_KEY", "CODEC_CREDENTIAL", "CODEC_TOO_LARGE", "CODEC_ALIAS_LIMIT"]);
  });
});

describe("SAAS §6.2 public-api.ts (names frozen at C3, fields additive by WP22)", () => {
  const NAMES = [
    "ErrorV1", "PageOf", "MeV1", "RelaySummaryV1", "RelayDetailV1", "RelaySourceV1", "VersionV1",
    "CompiledPreviewV1", "CreateRelayV1", "SaveSourceV1", "SaveDraftV1", "ValidateRequestV1", "ValidateResultV1",
    "DryRunV1", "PublicationV1", "RunV1", "CaseV1", "UsageV1", "WebhookEndpointV1", "WebhookDeliveryV1",
  ] as const;

  it("exports every §14 name", () => {
    for (const n of NAMES) expect([n, n in publicApi]).toEqual([n, true]);
  });

  it("every schema carries a .meta({id}) for zod-openapi, and PageOf wraps one", () => {
    for (const n of NAMES) {
      if (n === "PageOf") continue;
      const schema = (publicApi as Record<string, unknown>)[n] as z.ZodType;
      expect([n, schema.meta()?.id]).toEqual([n, n]);
    }
    const page = PageOf(z.object({ id: z.string() }));
    expect(page.parse({ data: [{ id: "a" }], next_cursor: null })).toEqual({ data: [{ id: "a" }], next_cursor: null });
    expect(page.safeParse({ data: [] }).success).toBe(false); // next_cursor is required, nullable
  });

  it("the §6.3 conventions hold: 1–100 per page, and the version header value", () => {
    expect(PAGE_LIMIT_DEFAULT).toBe(20);
    expect(PAGE_LIMIT_MAX).toBe(100);
    expect(PUBLIC_API_VERSION).toBe("2026-09-25");
  });

  it("the error envelope is the §6.3 shape", () => {
    const parsed = publicApi.ErrorV1.parse({ error: { code: "E_NOT_FOUND", message: "no", docs_url: "https://app/docs/api#errors" } });
    expect(parsed.error.code).toBe("E_NOT_FOUND");
  });

  it("a source body over 256 KiB is refused before it reaches the codec", () => {
    const big = { source: { format: "yaml" as const, text: "x".repeat(MAX_SOURCE_BYTES + 1) } };
    expect(publicApi.ValidateRequestV1.safeParse(big).success).toBe(false);
    expect(publicApi.SaveSourceV1.safeParse({ ...big, expectedRev: 1 }).success).toBe(false);
  });

  it("CreateRelayV1 accepts the three §6.2 sources and nothing else", () => {
    expect(publicApi.CreateRelayV1.safeParse({ from: { kind: "clone", relayId: "rl_1" } }).success).toBe(true);
    expect(publicApi.CreateRelayV1.safeParse({ from: { kind: "blueprint", blueprint: {} } }).success).toBe(true);
    expect(publicApi.CreateRelayV1.safeParse({ from: { kind: "source", source: { format: "json", text: "{}" } } }).success).toBe(true);
    expect(publicApi.CreateRelayV1.safeParse({ from: { kind: "url", url: "https://x" } }).success).toBe(false);
  });
});

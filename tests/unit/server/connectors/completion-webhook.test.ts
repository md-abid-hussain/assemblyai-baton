/**
 * WP16·3: the `completion_webhook` sender (PLATFORM §6.1, §6.2 — the T3 SHOULD).
 *
 * - the body carries the run header plus exactly the sections `include` asks for, and never an audio URL,
 *   a recording id, a transcript or a secret;
 * - it is signed with the documented algorithm, so `verifyHmac` (the same code `/api/connectors/echo` runs)
 *   accepts it and rejects a tampered body;
 * - the §5.6 host policy applies (the URL comes from a blueprint), and a blocked host posts nothing;
 * - a cloned relay whose signing secret was dropped refuses rather than sending an unsigned export;
 * - every attempt writes one `connector_calls` row, and a dead endpoint never throws into the run.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { HMAC_WINDOW_SEC } from "@/core/contracts/v2/api";
import type { Blueprint, CompiledRelay } from "@/core/contracts/v2";
import { BlueprintSchema } from "@/core/contracts/v2/blueprint";
import { compileRelay } from "@/core/relay/compile";
import { MemoryConnectorCallLog } from "@/server/connectors/call-log";
import { sendCompletionWebhooks, type CompletionFacts } from "@/server/connectors/completion-webhook";
import { verifyHmac } from "@/server/connectors/hmac";
import type { PublicHttpsPostResult } from "@/server/connectors/public-post";

const DENTAL = resolve(process.cwd(), "data/relays/dental-deposit.json");
const HOST = "hooks.acme-dental.com";
const SECRET = "completion-signing-secret-7f1a";
const REF = { $secret: "sec_abcdef0123456789" } as const;

function compiledWith(hook: Record<string, unknown>): CompiledRelay {
  const raw = JSON.parse(readFileSync(DENTAL, "utf8")) as Record<string, unknown>;
  const bp: Blueprint = BlueprintSchema.parse({ ...raw, connectors: [...(raw.connectors as unknown[]), hook] });
  return compileRelay(bp, { versionId: "rv_hook_1", relayId: "rel_dental", flagship: false });
}

const hook = (over: Record<string, unknown> = {}) => ({
  type: "completion_webhook",
  id: "desk_export",
  label: "Export to the practice system",
  url: `https://${HOST}/completion`,
  hmacSecret: REF,
  include: ["case", "payment"],
  ...over,
});

const facts: CompletionFacts = {
  runId: "tko_1",
  caseId: "case_1",
  outcome: "completed",
  endedAt: "2026-09-26T12:00:00.000Z",
  case: { patient_name: "verified", deposit: "confirmed" },
  qa: { re_asked: 0 },
  payment: { status: "succeeded", amount: 84 },
};

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function fakePost(sent: Sent[], answer: Partial<PublicHttpsPostResult> = {}) {
  return async (url: string, o: { headers?: Record<string, string>; body: string | Buffer }): Promise<PublicHttpsPostResult> => {
    sent.push({ url, headers: o.headers ?? {}, body: String(o.body) });
    return { ok: true, status: 200, errorCode: null, message: null, bodyText: "", ms: 3, address: "93.184.215.14", ...answer };
  };
}

const deps = (sent: Sent[], over: Record<string, unknown> = {}) => ({
  workspaceId: "org_acme",
  secrets: { resolve: async () => SECRET },
  callLog: new MemoryConnectorCallLog(),
  post: fakePost(sent),
  hostCheck: async (_o: string, h: string) => ({ ok: h === HOST, message: "not an allowed host" }),
  now: () => Date.parse("2026-09-26T12:00:05.000Z"),
  uuid: () => "11111111-2222-3333-4444-555555555555",
  ...over,
});

describe("the completion webhook", () => {
  it("sends only the included sections, signed with the documented algorithm", async () => {
    const sent: Sent[] = [];
    const d = deps(sent);
    const [r] = await sendCompletionWebhooks(compiledWith(hook()), facts, d);
    expect(r!.status).toBe("ok");
    expect(r!.httpStatus).toBe(200);
    expect(sent).toHaveLength(1);

    const body = JSON.parse(sent[0]!.body) as Record<string, unknown>;
    expect(body).toMatchObject({ event: "run.completed", relay: "dental-deposit", run: { id: "tko_1", outcome: "completed" } });
    expect(body.case).toEqual(facts.case);
    expect(body.payment).toEqual(facts.payment);
    expect(body.qa).toBeUndefined(); // not in `include`
    const text = sent[0]!.body;
    expect(text).not.toContain(SECRET);
    expect(text).not.toMatch(/audio|recording|transcript/i);

    const nowSec = Math.floor(Date.parse("2026-09-26T12:00:05.000Z") / 1000);
    expect(
      verifyHmac({
        secret: SECRET,
        signature: sent[0]!.headers["X-Changeover-Signature"],
        timestamp: sent[0]!.headers["X-Changeover-Timestamp"],
        rawBody: text,
        nowSec,
        windowSec: HMAC_WINDOW_SEC,
      }),
    ).toBe("valid");
    expect(
      verifyHmac({
        secret: SECRET,
        signature: sent[0]!.headers["X-Changeover-Signature"],
        timestamp: sent[0]!.headers["X-Changeover-Timestamp"],
        rawBody: `${text} `,
        nowSec,
      }),
    ).toBe("tampered");
    expect(sent[0]!.headers["X-Changeover-Delivery"]).toBe("11111111-2222-3333-4444-555555555555");
    expect((d.callLog as MemoryConnectorCallLog).rows).toHaveLength(1);
  });

  it("refuses a host the policy does not allow, and posts nothing", async () => {
    const sent: Sent[] = [];
    const d = deps(sent);
    const [r] = await sendCompletionWebhooks(compiledWith(hook({ url: "https://evil.example.com/hook" })), facts, d);
    expect(r!.status).toBe("blocked");
    expect(r!.errorCode).toBe("E_CONN_HOST_NOT_ALLOWED");
    expect(sent).toHaveLength(0);
    expect((d.callLog as MemoryConnectorCallLog).rows[0]!.status).toBe("blocked");
  });

  it("refuses to send unsigned when cloning dropped the signing secret (lint K2)", async () => {
    const sent: Sent[] = [];
    const [r] = await sendCompletionWebhooks(compiledWith(hook({ hmacSecret: null })), facts, deps(sent));
    expect(r!.status).toBe("refused");
    expect(r!.errorCode).toBe("E_CONN_SECRET_MISSING");
    expect(sent).toHaveLength(0);
  });

  it("a dead endpoint is recorded, not thrown", async () => {
    const sent: Sent[] = [];
    const d = deps(sent, {
      post: async (): Promise<PublicHttpsPostResult> => ({
        ok: false, status: null, errorCode: "E_CONN_TIMEOUT", message: "no answer", bodyText: "", ms: 5000, address: null,
      }),
    });
    const [r] = await sendCompletionWebhooks(compiledWith(hook()), facts, d);
    expect(r!.status).toBe("error");
    expect(r!.errorCode).toBe("E_CONN_TIMEOUT");
    expect((d.callLog as MemoryConnectorCallLog).rows).toHaveLength(1);
  });

  it("a relay with no completion webhook sends nothing at all", async () => {
    const raw = JSON.parse(readFileSync(DENTAL, "utf8")) as Record<string, unknown>;
    const compiled = compileRelay(BlueprintSchema.parse(raw), { versionId: "rv_1", relayId: "rel_dental", flagship: false });
    expect(await sendCompletionWebhooks(compiled, facts, deps([]))).toEqual([]);
  });
});

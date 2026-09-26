/**
 * WP16·3: the connector test console (PLATFORM §6.5).
 *
 * - `http_action` really runs, with the SSRF guard and the org host policy, and the report carries what the OWNER
 *   needs: the redacted request line and headers (`‹secret:name›`), the signature, status/ms/bytes, the picked
 *   result the agent would see, and the raw body;
 * - the raw body is capped at 2 KiB on the public deployment (`APP_ENV=production`) and whole locally;
 * - a secret value never appears anywhere in the response;
 * - money connectors are DRY RUNS: nothing is created, and the side-effect deps are never touched (they throw);
 * - an unknown connector id is a 404-shaped refusal, and a blocked host comes back as a blocked report.
 *
 * All local: one 127.0.0.1 server, a table resolver, $0.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Blueprint, CompiledRelay } from "@/core/contracts/v2";
import { BlueprintSchema } from "@/core/contracts/v2/blueprint";
import { compileRelay } from "@/core/relay/compile";
import { MemoryConnectorCallLog } from "@/server/connectors/call-log";
import { runConsoleTest } from "@/server/connectors/console";
import { RelayConnectorRuntime } from "@/server/connectors/runtime";

import { localTransport, PUBLIC_V4, startServer, tableResolver, type CapturedCall, type LocalServer } from "./helpers";

const DENTAL = resolve(process.cwd(), "data/relays/dental-deposit.json");
const HOST = "hooks.acme-dental.com";
const SECRET_VALUE = "dental-desk-token-9f2b7c41";
const SECRET_REF = { $secret: "sec_abcdef0123456789" } as const;

/** The gallery relay plus one `http_action`, which is what an owner adds on the Connectors tab. */
function compiledWithHttpAction(): CompiledRelay {
  const raw = JSON.parse(readFileSync(DENTAL, "utf8")) as Record<string, unknown>;
  const connectors = [...(raw.connectors as unknown[])];
  connectors.push({
    type: "http_action",
    id: "notify_desk",
    label: "Notify the desk",
    toolName: "notify_desk",
    description: "Tell the practice management system that a deposit was taken.",
    method: "POST",
    url: `https://${HOST}/relay/hook`,
    params: { type: "object", required: ["note"], properties: { note: { type: "string" } } },
    headers: [{ name: "X-Desk-Token", value: SECRET_REF }],
    hmacSecret: SECRET_REF,
    timeoutMs: 2000,
    responsePick: ["ticket.id"],
    sideEffect: true,
  });
  const bp: Blueprint = BlueprintSchema.parse({ ...raw, connectors });
  return compileRelay(bp, { versionId: "rv_console_1", relayId: "rel_dental", flagship: false });
}

const never = (what: string) => (): never => {
  throw new Error(`the console must not ${what}`);
};

function runtimeFor(port: number, calls: CapturedCall[]): RelayConnectorRuntime {
  return new RelayConnectorRuntime({
    secrets: {
      async resolve() {
        return SECRET_VALUE;
      },
      async nameOf() {
        return "desk_token";
      },
    },
    callLog: new MemoryConnectorCallLog(),
    payments: { create: never("create a payment") },
    store: {
      markConnector: never("mark a connector"),
      putConfirmationNumber: never("write a confirmation number"),
      setCaseStatus: never("move a case"),
    },
    hostCheck: async (_orgId, host) => ({ ok: host === HOST, message: `"${host}" is not an allowed host.` }),
    http: { resolver: tableResolver({ [HOST]: { v4: [PUBLIC_V4] } }), request: localTransport(port, calls) },
  });
}

describe("the connector test console", () => {
  let server: LocalServer;
  let calls: CapturedCall[];
  let compiled: CompiledRelay;
  let body: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    for (const k of ["APP_ENV", "APP_URL"]) savedEnv[k] = process.env[k];
    process.env.APP_ENV = "development";
    process.env.APP_URL = "https://changeover.app";
    compiled = compiledWithHttpAction();
    calls = [];
    body = JSON.stringify({ ticket: { id: "TCK-4181", queue: "front-desk" }, echoed: SECRET_VALUE });
    server = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
    });
  });

  afterEach(async () => {
    await server.close();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const run = (connectorId: string, args: Record<string, unknown> = {}) =>
    runConsoleTest(
      { orgId: "org_acme", relayId: "rel_dental", connectorId, args },
      { load: async () => ({ compiled, versionId: "rv_console_1" }), runtime: () => runtimeFor(server.port, calls) },
    );

  it("runs an http_action and reports the request, the signature and the agent's result", async () => {
    const r = await run("notify_desk", { note: "deposit taken" });
    expect(r.status).toBe("ok");
    expect(r.dryRun).toBe(false);
    expect(r.httpStatus).toBe(200);
    expect(r.result).toEqual({ data: { "ticket.id": "TCK-4181" }, http_status: 200 });
    expect(r.signature).toMatch(/^v1=[0-9a-f]{64}$/);
    expect(r.request?.method).toBe("POST");
    expect(r.reqBytes).toBeGreaterThan(0);
    expect(r.resBytes).toBe(Buffer.byteLength(body));
    expect(r.address).toBe(PUBLIC_V4);
    expect(r.relayVersionId).toBe("rv_console_1");
  });

  it("never shows a secret value — not in a header, not in the raw body", async () => {
    const r = await run("notify_desk", { note: "deposit taken" });
    const header = r.request!.headers.find((h) => h.name === "X-Desk-Token");
    expect(header?.value).toBe("‹secret:desk_token›");
    expect(JSON.stringify(r)).not.toContain(SECRET_VALUE);
    expect(r.raw).toContain("‹secret:desk_token›");
  });

  it("caps the raw body at 2 KiB on the public deployment, and keeps it whole locally", async () => {
    body = JSON.stringify({ ticket: { id: "TCK-4181" }, filler: "x".repeat(4000) });
    const local = await run("notify_desk", { note: "n" });
    expect(local.rawTruncated).toBe(false);
    expect(local.raw!.length).toBeGreaterThan(2048);

    process.env.APP_ENV = "production";
    const prod = await run("notify_desk", { note: "n" });
    expect(prod.rawTruncated).toBe(true);
    expect(prod.raw!.length).toBe(2048);
    // The agent's own result is unchanged by the cap: only `responsePick` ever reached it.
    expect(prod.result).toEqual({ data: { "ticket.id": "TCK-4181" }, http_status: 200 });
  });

  it("reports a blocked host as blocked, without dialling", async () => {
    const other = compileRelay(
      BlueprintSchema.parse({
        ...(JSON.parse(readFileSync(DENTAL, "utf8")) as Record<string, unknown>),
        connectors: [
          ...(JSON.parse(readFileSync(DENTAL, "utf8")) as { connectors: unknown[] }).connectors,
          {
            type: "http_action", id: "notify_desk", label: "Notify the desk", toolName: "notify_desk",
            description: "Tell the practice management system that a deposit was taken.",
            method: "POST", url: "https://evil.example.com/hook",
            params: { type: "object", required: [], properties: {} },
            headers: [], hmacSecret: null, timeoutMs: 2000, responsePick: [], sideEffect: true,
          },
        ],
      }),
      { versionId: "rv_console_1", relayId: "rel_dental", flagship: false },
    );
    compiled = other;
    const r = await run("notify_desk", {});
    expect(r.status).toBe("blocked");
    expect(r.errorCode).toBe("E_CONN_HOST_NOT_ALLOWED");
    expect(calls).toHaveLength(0);
  });

  it("dry-runs the money connectors: nothing is created, and the render says what would happen", async () => {
    const pay = compiled.blueprint!.connectors.find((c) => c.type === "payment_link")!;
    const r = await run(pay.id, { customer_agreed_to_text: true });
    expect(r.dryRun).toBe(true);
    expect(r.status).toBe("refused");
    expect(r.result).toEqual({ status: "dry_run" });
    expect(r.wouldDo).toMatchObject({ action: "create a payment link", clampUsd: { min: 1, max: 999 } });
    expect(r.httpStatus).toBeNull();
  });

  it("dry-runs the confirmation too (it would otherwise move a case)", async () => {
    const conf = compiled.blueprint!.connectors.find((c) => c.type === "confirmation")!;
    const r = await run(conf.id);
    expect(r.dryRun).toBe(true);
    expect(r.wouldDo).toMatchObject({ action: "send the confirmation" });
  });

  it("refuses an unknown connector id", async () => {
    await expect(run("no_such_connector")).rejects.toMatchObject({ code: "E_NOT_FOUND" });
  });
});

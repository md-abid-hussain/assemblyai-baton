/**
 * Blueprint `http_action` → request: secret refs resolve in the given (relay owner's) workspace; a null header (a
 * secret dropped by cloning) or a missing secret refuses with E_CONN_SECRET_MISSING before anything is sent; the
 * console view shows `‹secret:name›`, never the value.
 */
import { describe, expect, it } from "vitest";

import { ConnectorSchema } from "@/core/contracts/v2/blueprint";
import { ConnectorError } from "@/server/connectors/errors";
import { executeHttpAction } from "@/server/connectors/http";
import { prepareHttpAction, type HttpActionConnector } from "@/server/connectors/http-connector";
import { secretKeyringFromEnv } from "@/server/secrets/crypto";
import { MemorySecretRepo } from "@/server/secrets/repo";
import { ConnectorSecretStore } from "@/server/secrets/store";
import { localTransport, PUBLIC_V4, startServer, tableResolver, type CapturedCall } from "./helpers";

const RUN = { relay: "demo", version: 1, case: "c1", mode: "live" as const };
const VALUE = "demo-owner-secret-value-0123456789";

async function setup() {
  const store = new ConnectorSecretStore({ repo: new MemorySecretRepo(), keyring: () => secretKeyringFromEnv({ AGENT_TOOL_SECRET: "ikm-for-tests-0123456789" }) });
  const api = await store.put("ws_owner", "crm_key", VALUE);
  const sign = await store.put("ws_owner", "echo_demo", "changeover-demo-echo-not-secret");
  const connector = ConnectorSchema.parse({
    type: "http_action", id: "crm_note", label: "CRM note", toolName: "add_crm_note", description: "Adds a note to the CRM record.",
    method: "POST", url: "https://api.example.com/notes", params: { type: "object", required: [], properties: {} },
    headers: [{ name: "Authorization", value: { $secret: api.id } }, { name: "X-Plan", value: "demo" }],
    hmacSecret: { $secret: sign.id }, timeoutMs: 2000, responsePick: ["id"], sideEffect: true,
  }) as HttpActionConnector;
  return { store, connector };
}

describe("prepareHttpAction", () => {
  it("resolves header and HMAC secrets in the owner's workspace", async () => {
    const { store, connector } = await setup();
    const input = await prepareHttpAction(connector, { args: { note: "hi" }, run: RUN }, store, "ws_owner");
    expect(input.headers).toEqual([
      { name: "Authorization", value: VALUE, secretName: "crm_key" },
      { name: "X-Plan", value: "demo" },
    ]);
    expect(input.hmac).toEqual({ name: "echo_demo", value: "changeover-demo-echo-not-secret" });

    const server = await startServer((_q, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "note_1" }));
    });
    try {
      const calls: CapturedCall[] = [];
      const report = await executeHttpAction(input, {
        policy: { enforceAllowlist: false, hosts: [] }, resolver: tableResolver({ "api.example.com": { v4: [PUBLIC_V4] } }), request: localTransport(server.port, calls),
      });
      expect(report.agentResult).toEqual({ data: { id: "note_1" }, http_status: 200 });
      expect(server.seen[0]!.headers.authorization).toBe(VALUE);
      expect(report.request!.headers).toContainEqual({ name: "Authorization", value: "‹secret:crm_key›" });
      expect(JSON.stringify(report)).not.toContain(VALUE);
    } finally {
      await server.close();
    }
  });

  it("a visitor workspace cannot resolve the owner's refs", async () => {
    const { store, connector } = await setup();
    await expect(prepareHttpAction(connector, { args: {}, run: RUN }, store, "ws_visitor")).rejects.toMatchObject({ code: "E_CONN_SECRET_MISSING" });
  });

  it("a null header value (dropped by cloning) refuses before anything is sent", async () => {
    const { store, connector } = await setup();
    const cloned = { ...connector, headers: [{ name: "Authorization", value: null }] } as HttpActionConnector;
    const err = await prepareHttpAction(cloned, { args: {}, run: RUN }, store, "ws_owner").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect((err as ConnectorError).code).toBe("E_CONN_SECRET_MISSING");
    expect((err as ConnectorError).status).toBe("refused");
  });

  it("no hmacSecret → unsigned", async () => {
    const { store, connector } = await setup();
    const input = await prepareHttpAction({ ...connector, hmacSecret: null }, { args: {}, run: RUN }, store, "ws_owner");
    expect(input.hmac).toBeNull();
  });
});

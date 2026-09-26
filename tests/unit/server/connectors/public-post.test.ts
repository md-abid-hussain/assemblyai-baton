/**
 * WP16·3: `publicHttpsPost` — the guarded client WP24 delivers outbound webhooks on (SAAS §7.4, §10.3).
 *
 * The rules it MUST share with `http_action`: https:443 only, a pinned public-unicast address, no redirects, no
 * compressed body, a deadline, a byte cap. The rule it must NOT share: the §5.6 connector host allowlist — a
 * webhook endpoint is the customer's own URL, so an unlisted host is delivered to even on the public deployment.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { publicHttpsPost } from "@/server/connectors/public-post";

import { localTransport, PUBLIC_V4, startServer, tableResolver, type CapturedCall, type LocalServer } from "./helpers";

const HOST = "hooks.customer.example";

describe("publicHttpsPost", () => {
  let server: LocalServer;
  let calls: CapturedCall[];
  let reply: (res: import("node:http").ServerResponse) => void;
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    for (const k of ["APP_ENV", "CONNECTOR_HOST_ALLOWLIST"]) saved[k] = process.env[k];
    // The public deployment, with an allowlist that does NOT hold the endpoint's host.
    process.env.APP_ENV = "production";
    process.env.CONNECTOR_HOST_ALLOWLIST = "postman-echo.com";
    calls = [];
    reply = (res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ received: true }));
    };
    server = await startServer((_req, res) => reply(res));
  });

  afterEach(async () => {
    await server.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const post = (url = `https://${HOST}/hook`, table: Record<string, { v4?: string[] }> = { [HOST]: { v4: [PUBLIC_V4] } }) =>
    publicHttpsPost(url, {
      headers: { "webhook-id": "evt_1", "webhook-signature": "v1,abc" },
      body: JSON.stringify({ type: "run.completed" }),
      resolver: tableResolver(table),
      request: localTransport(server.port, calls),
    });

  it("delivers to a host that is NOT on the connector allowlist (webhooks are the customer's own URL)", async () => {
    const r = await post();
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    expect(r.errorCode).toBeNull();
    expect(r.bodyText).toContain("received");
    expect(r.address).toBe(PUBLIC_V4);
    expect(calls[0]!.options.servername).toBe(HOST);
    expect(calls[0]!.pinned.plain[0]).toBe(PUBLIC_V4);
    const headers = calls[0]!.options.headers as Record<string, string>;
    expect(headers["webhook-signature"]).toBe("v1,abc");
    expect(headers["Accept-Encoding"]).toBeUndefined();
  });

  it("keeps the SSRF guard: a private answer, a plain http URL and a non-443 port are all refused", async () => {
    expect((await post(`https://${HOST}/hook`, { [HOST]: { v4: ["169.254.169.254"] } })).errorCode).toBe("E_CONN_ADDRESS");
    expect((await post("http://hooks.customer.example/hook")).errorCode).toBe("E_CONN_URL");
    expect((await post("https://hooks.customer.example:8443/hook")).errorCode).toBe("E_CONN_URL");
    expect((await post("https://localhost/hook")).errorCode).toBe("E_CONN_ADDRESS");
    expect(calls).toHaveLength(0);
  });

  it("never follows a redirect and refuses a compressed body", async () => {
    reply = (res) => {
      res.writeHead(302, { location: "https://elsewhere.example/" });
      res.end();
    };
    expect((await post()).errorCode).toBe("E_CONN_REDIRECT");

    reply = (res) => {
      res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
      res.end("{}");
    };
    expect((await post()).errorCode).toBe("E_CONN_ENCODING");
  });

  it("reports a non-2xx as a failed attempt the caller can retry", async () => {
    reply = (res) => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("nope");
    };
    const r = await post();
    expect(r.ok).toBe(false);
    expect(r.status).toBe(500);
    expect(r.errorCode).toBe("E_CONN_HTTP");
    expect(r.bodyText).toBe("nope");
  });
});

/**
 * WP16 acceptance 1 + 2 (SSRF suite and DoS), URL/DNS level:
 * - URL rules (https:443 only, no userinfo, no localhost/single-label, IP literals checked) and the production
 *   host allowlist;
 * - names resolving to private addresses (mock resolver), mixed answers, NXDOMAIN;
 * - a HANGING resolver (a real c-ares Resolver pointed at a UDP black hole) gives E_CONN_DNS at ≈1.5 s while a
 *   concurrent crypto.pbkdf2 completes (the libuv threadpool is not blocked);
 * - the pinned lookup honours `options.all`, and a Node 22 `autoSelectFamily: true` connect works through it.
 */
import { pbkdf2 } from "node:crypto";
import dgram from "node:dgram";
import net from "node:net";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_CONNECTOR_HOST_ALLOWLIST, assertHostAllowed, destinationPolicy, isHostAllowed, parseDestination,
} from "@/server/connectors/destination";
import { createConnectorResolver, DNS_TIMEOUT_MS, pinnedLookup, resolvePublic } from "@/server/connectors/dns";
import { ConnectorError } from "@/server/connectors/errors";
import { PUBLIC_V4, PUBLIC_V6, tableResolver } from "./helpers";

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof ConnectorError ? e.code : `not a ConnectorError: ${String(e)}`;
  }
}
async function codeOfAsync(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (e) {
    return e instanceof ConnectorError ? e.code : `not a ConnectorError: ${String(e)}`;
  }
}

describe("parseDestination: URL rules", () => {
  it.each([
    ["http://example.com/hook", "E_CONN_URL"],
    ["ftp://example.com/", "E_CONN_URL"],
    ["https://example.com:8443/", "E_CONN_URL"],
    ["https://example.com:80/", "E_CONN_URL"],
    ["https://user:pw@example.com/", "E_CONN_URL"],
    ["https://user@example.com/", "E_CONN_URL"],
    ["not a url", "E_CONN_URL"],
    [`https://${"a".repeat(250)}.com/`, "E_CONN_URL"],
    ["https://localhost/", "E_CONN_ADDRESS"],
    ["https://api.localhost/", "E_CONN_ADDRESS"],
    ["https://intranet/", "E_CONN_ADDRESS"],
    ["https://127.0.0.1/", "E_CONN_ADDRESS"],
    ["https://2130706433/", "E_CONN_ADDRESS"],      // WHATWG → 127.0.0.1
    ["https://0x7f.1/", "E_CONN_ADDRESS"],          // WHATWG → 127.0.0.1
    ["https://169.254.169.254/latest/meta-data", "E_CONN_ADDRESS"],
    ["https://10.1.2.3/", "E_CONN_ADDRESS"],
    ["https://[::1]/", "E_CONN_ADDRESS"],
    ["https://[::ffff:127.0.0.1]/", "E_CONN_ADDRESS"],
    ["https://[fd00::1]/", "E_CONN_ADDRESS"],
    ["https://[64:ff9b::a9fe:a9fe]/", "E_CONN_ADDRESS"],
  ])("%s → %s", (url, code) => {
    expect(codeOf(() => parseDestination(url))).toBe(code);
  });

  it("accepts https names and public literals; normalises case, trailing dot and an explicit :443", () => {
    expect(parseDestination("https://Example.COM./x?y=1#frag")).toMatchObject({ host: "example.com", literal: null });
    expect(parseDestination("https://example.com:443/")).toMatchObject({ host: "example.com" });
    expect(parseDestination("https://8.8.8.8/").literal).toMatchObject({ ok: true, family: 4 });
    expect(parseDestination("https://[2606:4700:4700::1111]/").literal).toMatchObject({ ok: true, family: 6 });
    expect(parseDestination("https://example.com/#x").url.hash).toBe("");
  });
});

describe("host allowlist (production)", () => {
  it("is enforced with APP_ENV=production, and when APP_ENV is unset under NODE_ENV=production", () => {
    expect(destinationPolicy({ APP_ENV: "production" }).enforceAllowlist).toBe(true);
    expect(destinationPolicy({ NODE_ENV: "production" }).enforceAllowlist).toBe(true);
    expect(destinationPolicy({ NODE_ENV: "production", APP_ENV: "development" }).enforceAllowlist).toBe(false);
    expect(destinationPolicy({ NODE_ENV: "development" }).enforceAllowlist).toBe(false);
    expect(destinationPolicy({ NODE_ENV: "test" }).enforceAllowlist).toBe(false);
  });

  it("defaults to the §6.2 capture hosts plus the app's own host", () => {
    const p = destinationPolicy({ APP_ENV: "production", APP_URL: "https://changeover.example.app" });
    expect(p.hosts).toEqual([...DEFAULT_CONNECTOR_HOST_ALLOWLIST, "changeover.example.app"]);
    expect(isHostAllowed("postman-echo.com", p)).toBe(true);
    expect(isHostAllowed("changeover.example.app", p)).toBe(true);
    expect(isHostAllowed("evil.example.net", p)).toBe(false);
    expect(isHostAllowed("sub.postman-echo.com", p)).toBe(false);
    expect(isHostAllowed("postman-echo.com.evil.net", p)).toBe(false);
    expect(codeOf(() => assertHostAllowed("evil.example.net", p))).toBe("E_CONN_HOST_NOT_ALLOWED");
  });

  it("reads CONNECTOR_HOST_ALLOWLIST (comma list; *.suffix = sub-domains only; junk ignored)", () => {
    const p = destinationPolicy({ APP_ENV: "production", CONNECTOR_HOST_ALLOWLIST: " Hooks.Example.com , *.capture.test, https://x.example.org/p, bad host!" });
    expect(p.hosts).toEqual(["hooks.example.com", "*.capture.test", "x.example.org"]);
    expect(isHostAllowed("a.capture.test", p)).toBe(true);
    expect(isHostAllowed("capture.test", p)).toBe(false);
    expect(isHostAllowed("postman-echo.com", p)).toBe(false);
  });

  it("allows any host when not enforced (dev); the address guard still applies", () => {
    expect(isHostAllowed("anything.example", destinationPolicy({ APP_ENV: "development" }))).toBe(true);
  });
});

describe("resolvePublic (mock resolver)", () => {
  it("returns the first IPv4 answer when every answer is public", async () => {
    const r = tableResolver({ "api.example.com": { v4: [PUBLIC_V4, "8.8.8.8"], v6: [PUBLIC_V6] } });
    await expect(resolvePublic("api.example.com", r)).resolves.toMatchObject({ address: PUBLIC_V4, family: 4 });
    expect(r.calls).toEqual(["A api.example.com", "AAAA api.example.com"]);
  });

  it("falls back to IPv6 when there is no A record", async () => {
    const r = tableResolver({ "v6.example.com": { v6: [PUBLIC_V6] } });
    await expect(resolvePublic("v6.example.com", r)).resolves.toMatchObject({ address: PUBLIC_V6, family: 6 });
  });

  it.each([
    ["loopback", { v4: ["127.0.0.1"] }],
    ["RFC 1918", { v4: ["10.0.0.5"] }],
    ["metadata", { v4: ["169.254.169.254"] }],
    ["CGNAT", { v4: ["100.64.1.1"] }],
    ["ULA AAAA", { v6: ["fd00::1"] }],
    ["mapped AAAA", { v6: ["::ffff:127.0.0.1"] }],
    ["NAT64 AAAA", { v6: ["64:ff9b::a00:1"] }],
    ["one private among public", { v4: [PUBLIC_V4, "192.168.0.10"] }],
    ["public A, private AAAA", { v4: [PUBLIC_V4], v6: ["::1"] }],
  ])("a name resolving to %s → E_CONN_ADDRESS", async (_label, answers) => {
    const r = tableResolver({ "evil.example.com": answers });
    expect(await codeOfAsync(resolvePublic("evil.example.com", r))).toBe("E_CONN_ADDRESS");
  });

  it("NXDOMAIN → E_CONN_DNS", async () => {
    expect(await codeOfAsync(resolvePublic("nope.example.com", tableResolver({})))).toBe("E_CONN_DNS");
  });

  it("a resolver that never settles is cut by the backstop and cancelled", async () => {
    let cancelled = false;
    const hang = { resolve4: () => new Promise<string[]>(() => {}), resolve6: () => new Promise<string[]>(() => {}), cancel: () => { cancelled = true; } };
    const t0 = Date.now();
    expect(await codeOfAsync(resolvePublic("slow.example.com", hang, 200))).toBe("E_CONN_DNS");
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(cancelled).toBe(true);
  });
});

describe("DoS: a hanging DNS server does not block the threadpool", () => {
  it("c-ares times out at ≈1.5 s while concurrent pbkdf2 jobs finish first", async () => {
    // A UDP socket that swallows queries: a DNS server that never answers.
    const sock = dgram.createSocket("udp4");
    await new Promise<void>((resolve) => sock.bind(0, "127.0.0.1", resolve));
    const port = (sock.address() as AddressInfo).port;
    try {
      const resolver = createConnectorResolver([`127.0.0.1:${port}`]);
      const t0 = Date.now();
      const dns = resolvePublic("hang.example.com", resolver).then(
        () => ({ code: null as string | null, ms: Date.now() - t0 }),
        (e: unknown) => ({ code: e instanceof ConnectorError ? e.code : String(e), ms: Date.now() - t0 }),
      );
      // Saturate the 4-thread libuv pool while the lookup hangs. dns.lookup would sit on this pool; c-ares must not.
      const crypto = Promise.all(
        Array.from({ length: 8 }, () =>
          new Promise<number>((resolve, reject) =>
            pbkdf2("pw", "salt", 20_000, 32, "sha256", (err) => (err ? reject(err) : resolve(Date.now() - t0)))),
        ),
      );
      const [dnsResult, cryptoMs] = await Promise.all([dns, crypto]);
      expect(dnsResult.code).toBe("E_CONN_DNS");
      expect(dnsResult.ms).toBeGreaterThanOrEqual(DNS_TIMEOUT_MS - 200);
      expect(dnsResult.ms).toBeLessThan(DNS_TIMEOUT_MS + 700);
      expect(Math.max(...cryptoMs)).toBeLessThan(dnsResult.ms);
    } finally {
      sock.close();
    }
  });
});

describe("pinnedLookup", () => {
  it("answers the pinned address, as a pair or (options.all) as an array", async () => {
    const lookup = pinnedLookup("203.0.113.5", 4) as unknown as (h: string, o: object | ((...a: unknown[]) => void), cb?: (...a: unknown[]) => void) => void;
    const plain = await new Promise<unknown[]>((resolve) => lookup("any.example.com", {}, (...a) => resolve(a)));
    expect(plain).toEqual([null, "203.0.113.5", 4]);
    const all = await new Promise<unknown[]>((resolve) => lookup("any.example.com", { all: true }, (...a) => resolve(a)));
    expect(all).toEqual([null, [{ address: "203.0.113.5", family: 4 }]]);
    const noOpts = await new Promise<unknown[]>((resolve) => lookup("any.example.com", (...a) => resolve(a)));
    expect(noOpts).toEqual([null, "203.0.113.5", 4]);
  });

  it("a Node 22 autoSelectFamily connect goes through it (and never touches DNS)", async () => {
    const server = net.createServer((s) => s.end("pong"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      for (const autoSelectFamily of [true, false]) {
        const text = await new Promise<string>((resolve, reject) => {
          const c = net.connect({ host: "this-name-does-not-exist.invalid", port, lookup: pinnedLookup("127.0.0.1", 4), autoSelectFamily });
          let buf = "";
          c.on("data", (d) => (buf += d.toString()));
          c.on("end", () => resolve(buf));
          c.on("error", reject);
        });
        expect(text).toBe("pong");
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

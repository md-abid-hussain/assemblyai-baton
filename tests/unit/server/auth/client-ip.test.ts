import { describe, expect, it } from "vitest";

import {
  addrClass, clientHop, describeForwarding, ipKeyMode, ipPrefix, rightmostForwardedFor, trustsForwardedFor,
} from "@/server/auth/client-ip";

const h = (o: Record<string, string>) => new Headers(o);

describe("ipPrefix (/24 for IPv4, /48 for IPv6)", () => {
  it("groups IPv4 by /24, with or without a port", () => {
    expect(ipPrefix("198.51.100.4")).toBe("198.51.100.0/24");
    expect(ipPrefix(" 198.51.100.250 ")).toBe("198.51.100.0/24");
    expect(ipPrefix("198.51.100.4:51234")).toBe("198.51.100.0/24");
  });

  it("groups IPv6 by /48 (full, compressed, bracketed with port, zone id)", () => {
    expect(ipPrefix("2001:0db8:85a3:0000:0000:8a2e:0370:7334")).toBe("2001:db8:85a3::/48");
    expect(ipPrefix("2001:db8:85a3::1")).toBe("2001:db8:85a3::/48");
    expect(ipPrefix("2001:db8:85a3:ffff::")).toBe("2001:db8:85a3::/48");
    expect(ipPrefix("[2001:db8:85a3::1]:443")).toBe("2001:db8:85a3::/48");
    expect(ipPrefix("fe80::1%eth0")).toBe("fe80:0:0::/48");
    expect(ipPrefix("::1")).toBe("0:0:0::/48");
    expect(ipPrefix("2001:db8::")).toBe("2001:db8:0::/48");
  });

  it("treats IPv4-mapped IPv6 as IPv4", () => {
    expect(ipPrefix("::ffff:198.51.100.4")).toBe("198.51.100.0/24");
    expect(ipPrefix("::ffff:c633:6404")).toBe("198.51.100.0/24");
  });

  it("rejects garbage and oversized values", () => {
    for (const bad of ["", "unknown", "256.1.1.1", "1.2.3", "1.2.3.4.5", "2001:db8::1::2", "1:2:3:4:5:6:7:8:9", "gggg::1", "x".repeat(80), ":1:2:3:4:5:6:7"]) {
      expect(ipPrefix(bad), bad).toBeNull();
    }
  });
});

describe("clientHop (the balancer-set hop; PLATFORM v2.1 §10.2)", () => {
  // Zerops L7: X-Real-IP overwritten with the client; the client is appended to any X-Forwarded-For chain.
  const zerops = (spoofChain: string | null, client: string) =>
    h({ "x-forwarded-for": spoofChain ? `${spoofChain}, ${client}` : client, "x-real-ip": client });

  it("ignores a client-controlled leftmost X-Forwarded-For entry", () => {
    for (const mode of ["real-ip", "xff-right"] as const) {
      expect(clientHop(zerops(null, "198.51.100.4"), { mode })).toBe("198.51.100.0/24");
      expect(clientHop(zerops("203.0.113.7", "198.51.100.4"), { mode })).toBe("198.51.100.0/24");
      expect(clientHop(zerops("203.0.113.7, 192.0.2.1", "198.51.100.4"), { mode })).toBe("198.51.100.0/24");
    }
  });

  it("real-ip mode prefers X-Real-IP and otherwise answers unknown (QA-FIX: no client-controlled XFF fallback)", () => {
    expect(clientHop(h({ "x-real-ip": "198.51.100.4", "x-forwarded-for": "192.0.2.9" }), { mode: "real-ip" })).toBe("198.51.100.0/24");
    // Without a proxy in front, every one of these is attacker-typed, so none of them may mint a fresh bucket.
    expect(clientHop(h({ "x-real-ip": "nonsense", "x-forwarded-for": "1.1.1.1, 192.0.2.9" }), { mode: "real-ip" })).toBe("unknown");
    expect(clientHop(h({ "x-forwarded-for": "1.1.1.1, 192.0.2.9, " }), { mode: "real-ip" })).toBe("unknown");
    expect(clientHop(h({}), { mode: "real-ip" })).toBe("unknown");
  });

  it("real-ip mode reads the rightmost XFF entry only when an operator vouches for the proxy (IPKEY_TRUST_XFF=1)", () => {
    const opts = { mode: "real-ip", trustXff: true } as const;
    expect(clientHop(h({ "x-real-ip": "nonsense", "x-forwarded-for": "1.1.1.1, 192.0.2.9" }), opts)).toBe("192.0.2.0/24");
    expect(clientHop(h({ "x-forwarded-for": "1.1.1.1, 192.0.2.9, " }), opts)).toBe("192.0.2.0/24");
    // X-Real-IP still wins when it parses, trusted or not.
    expect(clientHop(h({ "x-real-ip": "198.51.100.4", "x-forwarded-for": "192.0.2.9" }), opts)).toBe("198.51.100.0/24");
    expect(trustsForwardedFor("1")).toBe(true);
    for (const raw of [undefined, "", "0", "true", "yes"]) expect(trustsForwardedFor(raw)).toBe(false);
  });

  it("a spoofed X-Forwarded-For cannot mint fresh ipKey buckets (QA-FIX: the guest-start limiter bypass)", () => {
    // The break-it pass sent 10 requests with 10 attacker-chosen XFF values after tripping ipkey_hour, and all
    // 10 got through. Untrusted, they must all collapse onto one key.
    const keys = new Set(
      ["203.0.113.1", "203.0.113.2", "198.18.0.9", "1.2.3.4", "8.8.8.8"].map((ip) =>
        clientHop(h({ "x-forwarded-for": ip }), { mode: "real-ip" }),
      ),
    );
    expect([...keys]).toEqual(["unknown"]);
  });

  it("xff-right mode prefers the rightmost XFF entry", () => {
    expect(clientHop(h({ "x-real-ip": "198.51.100.4", "x-forwarded-for": "192.0.2.9" }), { mode: "xff-right" })).toBe("192.0.2.0/24");
    expect(clientHop(h({ "x-real-ip": "198.51.100.4" }), { mode: "xff-right" })).toBe("198.51.100.0/24");
  });

  it("off mode returns a fresh key per request (per-ipKey buckets never bind)", () => {
    const a = clientHop(zerops(null, "198.51.100.4"), { mode: "off" });
    const b = clientHop(zerops(null, "198.51.100.4"), { mode: "off" });
    expect(a.startsWith("off:")).toBe(true);
    expect(a).not.toBe(b);
    expect(a).not.toContain("198");
  });

  it("rightmostForwardedFor reads the last non-empty entry", () => {
    expect(rightmostForwardedFor(h({ "x-forwarded-for": "a, b ,c" }))).toBe("c");
    expect(rightmostForwardedFor(h({ "x-forwarded-for": " , " }))).toBeNull();
    expect(rightmostForwardedFor(h({}))).toBeNull();
  });

  it("IPKEY_MODE parsing defaults to real-ip", () => {
    expect(ipKeyMode(undefined)).toBe("real-ip");
    expect(ipKeyMode("")).toBe("real-ip");
    expect(ipKeyMode("bogus")).toBe("real-ip");
    expect(ipKeyMode(" OFF ")).toBe("off");
    expect(ipKeyMode("xff-right")).toBe("xff-right");
  });
});

describe("P-0 probe summary (address classes only)", () => {
  it("classifies addresses without exposing them", () => {
    expect(addrClass(null)).toBe("none");
    expect(addrClass("nope")).toBe("invalid");
    expect(addrClass("8.8.8.8")).toBe("public");
    expect(addrClass("10.1.2.3")).toBe("private");
    expect(addrClass("172.20.0.1")).toBe("private");
    expect(addrClass("192.168.1.1:80")).toBe("private");
    expect(addrClass("100.100.0.1")).toBe("cgnat");
    expect(addrClass("127.0.0.1")).toBe("loopback");
    expect(addrClass("169.254.169.254")).toBe("linklocal");
    expect(addrClass("203.0.113.7")).toBe("testnet");
    expect(addrClass("::ffff:10.0.0.1")).toBe("private");
    expect(addrClass("::1")).toBe("loopback");
    expect(addrClass("fd00::1")).toBe("private");
    expect(addrClass("fe80::1")).toBe("linklocal");
    expect(addrClass("2001:db8::1")).toBe("testnet");
    expect(addrClass("2a00:1450:4001::1")).toBe("public");
  });

  it("describes a trustworthy Zerops balancer (spoofed XFF and X-Real-IP from the probe)", () => {
    const d = describeForwarding(h({ "x-forwarded-for": "203.0.113.7, 8.8.4.4", "x-real-ip": "8.8.4.4" }), { mode: "real-ip" });
    expect(d).toEqual({
      mode: "real-ip", xffEntries: 2, xffLeft: "testnet", xffRight: "public", realIp: "public",
      realIpEqualsXffRight: true, forwardedHeaderPresent: false, keyedOn: "x-real-ip",
    });
    expect(JSON.stringify(d)).not.toContain("8.8");
  });

  it("flags a surviving client X-Real-IP and an inner hop", () => {
    const survived = describeForwarding(h({ "x-forwarded-for": "203.0.113.7, 8.8.4.4", "x-real-ip": "203.0.113.9" }), { mode: "real-ip" });
    expect(survived.realIp).toBe("testnet");
    expect(survived.realIpEqualsXffRight).toBe(false);
    const inner = describeForwarding(h({ "x-forwarded-for": "8.8.4.4, 10.0.0.5", "x-real-ip": "10.0.0.5" }), { mode: "xff-right" });
    expect(inner).toMatchObject({ xffRight: "private", realIp: "private", keyedOn: "xff-right" });
    expect(describeForwarding(h({}), { mode: "off" }).keyedOn).toBe("off");
    expect(describeForwarding(h({ forwarded: "for=1.2.3.4" }), { mode: "real-ip" })).toMatchObject({ forwardedHeaderPresent: true, keyedOn: "unknown" });
  });
});

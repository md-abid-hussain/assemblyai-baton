import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import nextConfig, { CONTENT_SECURITY_POLICY, CSP_DIRECTIVES } from "../../../next.config.mjs";
import { CASE_MODES, CASE_STATUSES, CONFIDENCES } from "../../../src/core/contracts";
import { ALL_TABLES, cases, factEvents } from "../../../src/server/db/schema";
import { cn } from "../../../src/lib/utils";

const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

describe("initial migration (DESIGN §4.2)", () => {
  const sql = readFileSync(join(ROOT, "drizzle", "0000_init.sql"), "utf8");
  const journal = JSON.parse(readFileSync(join(ROOT, "drizzle", "meta", "_journal.json"), "utf8")) as { entries: { tag: string }[] };

  it("is ONE migration that creates every table", () => {
    // WP14b: 0001_relays (PLATFORM §2.4) is the one additive migration after the initial one.
    expect(journal.entries.map((e) => e.tag)).toEqual(["0000_init", "0001_relays"]);
    for (const t of ALL_TABLES) expect(sql).toContain(`CREATE TABLE "${t}"`);
    expect((sql.match(/CREATE TABLE/g) ?? []).length).toBe(ALL_TABLES.length);
  });

  it("stores every FactEvent field and fractional clock values (G0)", () => {
    const table = (name: string) => sql.match(new RegExp(`CREATE TABLE "${name}" \\(([\\s\\S]*?)\\n\\);`))?.[1] ?? "";
    expect(table("fact_events")).toMatch(/"turn_end_ms" double precision NOT NULL,/);
    expect(table("fact_events")).toMatch(/"confidence" text NOT NULL,/);
    for (const col of ["start_ms", "end_ms", "recv_ms"]) expect(table("turns")).toMatch(new RegExp(`"${col}" double precision NOT NULL`));
    expect(table("turns")).toMatch(/"extract_ms" double precision,/);
    expect(table("cases")).toMatch(/"t_arm_ms" double precision,/);
    expect(table("takeovers")).toMatch(/"t_arm_ms" double precision NOT NULL/);
    expect(table("verifier_runs")).toMatch(/"upto_turn_recv_ms" double precision NOT NULL/);
    expect(table("verifier_runs")).toMatch(/"ms" double precision NOT NULL/);
    expect(table("live_sessions")).toMatch(/"billed_seconds" double precision,/);
  });

  it("uses the contract enums for cases.status and cases.mode", () => {
    expect([...cases.status.enumValues]).toEqual([...CASE_STATUSES]);
    expect([...cases.mode.enumValues]).toEqual([...CASE_MODES]);
    expect([...factEvents.confidence.enumValues]).toEqual([...CONFIDENCES]);
  });

  it("has the uniqueness guarantees the services rely on", () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX "fact_events_case_seq_uq"/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX "tool_calls_takeover_call_uq"/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX "payments_checkout_uq"/);
    expect(sql).toMatch(/ON DELETE cascade/);
  });
});

describe("security headers (DESIGN §8.4)", () => {
  it("sets CSP, Permissions-Policy, Referrer-Policy and nosniff on every path", async () => {
    expect(typeof nextConfig.headers).toBe("function");
    const rules = await nextConfig.headers!();
    expect(rules[0]?.source).toBe("/(.*)");
    const names = rules[0]?.headers.map((h: { key: string }) => h.key);
    expect(names).toEqual(["Content-Security-Policy", "Permissions-Policy", "Referrer-Policy", "X-Content-Type-Options"]);
  });

  it("allows the AssemblyAI sockets, Polar frames and blob: worklets", () => {
    expect(CSP_DIRECTIVES["connect-src"]).toEqual(expect.arrayContaining(["wss://streaming.assemblyai.com", "wss://agents.assemblyai.com"]));
    expect(CSP_DIRECTIVES["worker-src"]).toContain("blob:");
    expect(CSP_DIRECTIVES["script-src"]).toContain("blob:");
    expect(CSP_DIRECTIVES["frame-src"]).toEqual(expect.arrayContaining(["https://sandbox.polar.sh", "https://*.stripe.com"]));
    expect(CONTENT_SECURITY_POLICY).toMatch(/^default-src 'self'; /);
  });

  it("keeps the standalone output, external pg/ws and the TS gate outside next build", () => {
    expect(nextConfig.output).toBe("standalone");
    expect(nextConfig.serverExternalPackages).toEqual(["pg", "ws"]);
    expect(nextConfig.typescript?.ignoreBuildErrors).toBe(true);
    expect(nextConfig.poweredByHeader).toBe(false);
  });
});

describe("cn()", () => {
  it("merges clsx-style inputs and resolves Tailwind conflicts", () => {
    expect(cn("px-2", { "py-1": true, hidden: false }, ["px-4", null, undefined])).toBe("py-1 px-4");
  });
});

/**
 * The `lookup_table` parser (results under `data`), the connector-side `validateToolArgs`, the call-log dedupe
 * helpers and the §6.2 call limits.
 */
import { describe, expect, it } from "vitest";

import { validateToolArgs, type ToolParams } from "@/server/connectors/args";
import { argsHash, canonicalJson, MemoryConnectorCallLog } from "@/server/connectors/call-log";
import { lookupRow, parseCsv, parseLookupTable, LOOKUP_LIMITS } from "@/server/connectors/lookup-table";
import { CONNECTOR_LIMITS, ConnectorRateLimiter } from "@/server/connectors/rate-limit";

const PRICES_CSV = `﻿procedure,label,deposit_usd
cleaning,Teeth cleaning,40
crown,"Crown, porcelain",250
"root canal","Root canal ""molar""",180\r
`;

describe("lookup_table parser", () => {
  it("parses RFC 4180 CSV (BOM, quotes, escaped quotes, commas, CRLF, trailing newline)", () => {
    expect(parseCsv('a,"b,c","d ""e"""\r\n1,2,3\n')).toEqual([["a", "b,c", 'd "e"'], ["1", "2", "3"]]);
    const r = parseLookupTable({ format: "csv", data: PRICES_CSV, keyColumn: "procedure" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.table.columns).toEqual(["procedure", "label", "deposit_usd"]);
    expect(r.table.rows).toHaveLength(3);
    expect(lookupRow(r.table, "Root  Canal ")).toEqual({ data: { procedure: "root canal", label: 'Root canal "molar"', deposit_usd: "180" } });
    expect(lookupRow(r.table, "crown")).toEqual({ data: { procedure: "crown", label: "Crown, porcelain", deposit_usd: "250" } });
    expect(lookupRow(r.table, "implant")).toEqual({ status: "not_found" });
    expect(lookupRow(r.table, { key: "crown" })).toEqual({ status: "not_found" });
  });

  it("parses JSON arrays of flat objects (numbers/booleans → strings; missing keys → '')", () => {
    const r = parseLookupTable({ format: "json", data: JSON.stringify([{ id: "A1", price: 12.5, active: true }, { id: "B2", price: 3 }]), keyColumn: "id" });
    expect(r.ok && r.table.rows).toEqual([{ id: "A1", price: "12.5", active: "true" }, { id: "B2", price: "3", active: "" }]);
    expect(r.ok && lookupRow(r.table, "a1")).toEqual({ data: { id: "A1", price: "12.5", active: "true" } });
    expect(r.ok && lookupRow(r.table, 3)).toEqual({ status: "not_found" });
  });

  it.each([
    ["too many rows", { format: "csv", data: "k\n" + Array.from({ length: LOOKUP_LIMITS.maxRows + 1 }, (_, i) => `r${i}`).join("\n"), keyColumn: "k" }],
    ["too many columns", { format: "csv", data: "a,b,c,d,e,f,g,h,i\n1,2,3,4,5,6,7,8,9", keyColumn: "a" }],
    ["too many bytes", { format: "csv", data: "k,v\n" + "x,".padEnd(33_000, "y"), keyColumn: "k" }],
    ["missing key column", { format: "csv", data: "a,b\n1,2", keyColumn: "k" }],
    ["duplicate keys", { format: "csv", data: "k\nx\nX ", keyColumn: "k" }],
    ["empty key", { format: "csv", data: "k,v\n,1", keyColumn: "k" }],
    ["ragged row", { format: "csv", data: "k,v\n1", keyColumn: "k" }],
    ["unterminated quote", { format: "csv", data: 'k\n"abc', keyColumn: "k" }],
    ["no rows", { format: "csv", data: "k,v\n", keyColumn: "k" }],
    ["duplicate columns", { format: "csv", data: "k,k\n1,2", keyColumn: "k" }],
    ["JSON not an array", { format: "json", data: '{"k":"1"}', keyColumn: "k" }],
    ["JSON nested value", { format: "json", data: '[{"k":"1","v":{"x":1}}]', keyColumn: "k" }],
    ["JSON does not parse", { format: "json", data: "[{", keyColumn: "k" }],
    ["cell over 200 chars", { format: "csv", data: `k,v\n1,${"z".repeat(201)}`, keyColumn: "k" }],
  ] as const)("refuses %s", (_label, i) => {
    const r = parseLookupTable(i as Parameters<typeof parseLookupTable>[0]);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors.length).toBeGreaterThan(0);
  });

  it("checks the columns against the table definition when given", () => {
    const r = parseLookupTable({ format: "csv", data: "procedure,price\ncleaning,40", keyColumn: "procedure", expectColumns: ["procedure", "deposit_usd"] });
    expect(!r.ok && r.errors.join()).toContain('"price"');
  });

  it("a column named __proto__ stays an own data property", () => {
    const r = parseLookupTable({ format: "csv", data: "k,__proto__\na,polluted", keyColumn: "k" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const hit = lookupRow(r.table, "a") as { data: Record<string, string> };
    expect(Object.getPrototypeOf(hit.data)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(hit.data, "__proto__")?.value).toBe("polluted");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("validateToolArgs (connector side)", () => {
  const params: ToolParams = {
    type: "object",
    required: ["procedure", "agreed"],
    properties: {
      procedure: { type: "string", enum: ["cleaning", "crown"] },
      zip: { type: "string", pattern: "^\\d{5}$" },
      count: { type: "integer" },
      amount: { type: "number" },
      agreed: { type: "boolean" },
    },
  };

  it("accepts valid args and drops undeclared keys", () => {
    expect(validateToolArgs(params, { procedure: "crown", agreed: true, zip: "02139", count: 2, amount: 1.5, extra: "dropped" }))
      .toEqual({ ok: true, args: { procedure: "crown", zip: "02139", count: 2, amount: 1.5, agreed: true } });
    expect(validateToolArgs(params, { procedure: "crown", agreed: false, zip: null })).toEqual({ ok: true, args: { procedure: "crown", agreed: false } });
  });

  it.each([
    ["not an object", "crown"],
    ["an array", ["crown"]],
    ["missing required", { procedure: "crown" }],
    ["null required", { procedure: "crown", agreed: null }],
    ["enum miss", { procedure: "implant", agreed: true }],
    ["pattern miss", { procedure: "crown", agreed: true, zip: "0213" }],
    ["string for boolean", { procedure: "crown", agreed: "true" }],
    ["float for integer", { procedure: "crown", agreed: true, count: 1.5 }],
    ["string for number", { procedure: "crown", agreed: true, amount: "3" }],
    ["NaN", { procedure: "crown", agreed: true, amount: Number.NaN }],
    ["over-long string", { procedure: "crown", agreed: true, zip: "1".repeat(1001) }],
  ])("refuses %s", (_l, args) => {
    expect(validateToolArgs(params, args).ok).toBe(false);
  });
});

describe("call log helpers", () => {
  it("argsHash is key-order independent and tool-specific", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[1,{"y":2,"z":1}]},"b":1}');
    expect(argsHash("t", { a: 1, b: 2 })).toBe(argsHash("t", { b: 2, a: 1 }));
    expect(argsHash("t", { a: 1 })).not.toBe(argsHash("u", { a: 1 }));
    expect(argsHash("t", { a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });

  it("findRecent returns the newest ok call in the window (the gateway dedupe)", async () => {
    const log = new MemoryConnectorCallLog();
    const base = {
      caseId: "c", takeoverId: "tk_1", relayVersionId: "rv_1", publicationId: "pub_1", connectorId: "pay", toolName: "send_link",
      mode: "published" as const, httpStatus: null, ms: 5, reqBytes: 0, resBytes: 0, argsHash: "h1", errorCode: null,
    };
    const t = Date.now();
    await log.record({ ...base, status: "ok", result: { status: "link_sent", n: 1 }, createdAt: new Date(t - 40_000) });
    await log.record({ ...base, status: "error", result: null, createdAt: new Date(t - 5_000) });
    expect(await log.findRecent({ takeoverId: "tk_1", toolName: "send_link", argsHash: "h1", since: new Date(t - 30_000) })).toBeNull();
    await log.record({ ...base, status: "ok", result: { status: "link_sent", n: 2 }, createdAt: new Date(t - 1_000) });
    expect((await log.findRecent({ takeoverId: "tk_1", toolName: "send_link", argsHash: "h1", since: new Date(t - 30_000) }))?.result).toEqual({ status: "link_sent", n: 2 });
    expect(await log.findRecent({ takeoverId: "tk_1", toolName: "send_link", argsHash: "h2", since: new Date(t - 30_000) })).toBeNull();
  });
});

describe("connector call limits (§6.2)", () => {
  const key = (o: Partial<Parameters<ConnectorRateLimiter["take"]>[0]> = {}) => ({
    runKey: "tk_1", connectorId: "hook", workspaceId: "ws_a", host: "api.example.com", ...o,
  });

  it("≤ 10 per run per connector", () => {
    const l = new ConnectorRateLimiter();
    for (let i = 0; i < CONNECTOR_LIMITS.perRunPerConnector; i++) expect(l.take(key({ host: `h${i}.example.com` }), 1000 + i).ok).toBe(true);
    expect(l.take(key({ host: "hx.example.com" }), 2000)).toMatchObject({ ok: false, limit: "perRunPerConnector" });
    expect(l.take(key({ connectorId: "other", host: "hy.example.com" }), 2000).ok).toBe(true);
  });

  it("≤ 20 per minute per host, recovering after the minute", () => {
    const l = new ConnectorRateLimiter();
    for (let i = 0; i < 20; i++) expect(l.take(key({ runKey: `r${i}` }), 1000).ok).toBe(true);
    const v = l.take(key({ runKey: "r-late" }), 1000);
    expect(v).toMatchObject({ ok: false, limit: "perHostPerMinute" });
    expect(!v.ok && v.retryAfterMs).toBeGreaterThan(0);
    expect(l.take(key({ runKey: "r-next" }), 61_001).ok).toBe(true);
  });

  it("≤ 60 per hour per workspace; ≤ 300 per hour globally; ≤ 2000 per day globally", () => {
    const l = new ConnectorRateLimiter();
    let t = 0;
    for (let i = 0; i < 60; i++) expect(l.take(key({ runKey: `r${i}`, host: `h${i}.example.com` }), (t += 10)).ok).toBe(true);
    expect(l.take(key({ runKey: "r-x", host: "hz.example.com" }), (t += 10))).toMatchObject({ ok: false, limit: "perWorkspacePerHour" });
    const g = new ConnectorRateLimiter();
    for (let i = 0; i < 300; i++) expect(g.take(key({ runKey: null, workspaceId: `ws_${i}`, host: null }), 5000).ok).toBe(true);
    expect(g.take(key({ runKey: null, workspaceId: "ws_new", host: null }), 5000)).toMatchObject({ ok: false, limit: "globalPerHour" });
    const d = new ConnectorRateLimiter({ ...CONNECTOR_LIMITS, globalPerHour: 10_000 });
    for (let i = 0; i < 2000; i++) d.take(key({ runKey: null, workspaceId: `ws_${i}`, host: null }), i * 1000);
    expect(d.take(key({ runKey: null, workspaceId: "ws_new", host: null }), 2_000_000)).toMatchObject({ ok: false, limit: "globalPerDay" });
  });

  it("a refused call is not counted", () => {
    const l = new ConnectorRateLimiter({ ...CONNECTOR_LIMITS, perRunPerConnector: 1 });
    expect(l.take(key(), 1).ok).toBe(true);
    for (let i = 0; i < 50; i++) expect(l.take(key(), 2).ok).toBe(false);
    expect(l.take(key({ runKey: "tk_2" }), 3).ok).toBe(true);
  });
});

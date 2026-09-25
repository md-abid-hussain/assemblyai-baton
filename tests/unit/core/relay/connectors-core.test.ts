/**
 * The connector seams WP16 asked the kernel to own (docs/notes/requests/wp16-to-wp14a.md): `validateToolArgs`
 * (same cases WP16 pins in tests/unit/server/connectors/lookup-args-limits.test.ts), the `lookup_table` parser moved
 * into src/core/relay/, and the lint mirrors of the runtime's header and URL refusals (S3) and table loads (L2).
 */
import { describe, expect, it } from "vitest";
import type { Blueprint } from "@/core/contracts/v2";
import { connectorUrlProblem, isForbiddenDeclaredHeader } from "@/core/relay/connector-rules";
import { lintBlueprint } from "@/core/relay/lint";
import { LOOKUP_LIMITS, lookupRow, parseCsv, parseLookupTable, utf8Bytes } from "@/core/relay/lookup-table";
import { validateToolArgs, type ToolParams } from "@/core/relay/tool-args";
import { miniBlueprint } from "./fixtures/mini-blueprint";

describe("validateToolArgs (kernel copy; WP16's semantics)", () => {
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
    expect(validateToolArgs({ type: "object", required: [], properties: {} }, Object.create(null))).toEqual({ ok: true, args: {} });
  });

  it.each([
    ["not an object", "crown"],
    ["an array", ["crown"]],
    ["a class instance", new Date()],
    ["missing required", { procedure: "crown" }],
    ["null required", { procedure: "crown", agreed: null }],
    ["enum miss", { procedure: "implant", agreed: true }],
    ["pattern miss", { procedure: "crown", agreed: true, zip: "0213" }],
    ["string for boolean", { procedure: "crown", agreed: "true" }],
    ["float for integer", { procedure: "crown", agreed: true, count: 1.5 }],
    ["unsafe integer", { procedure: "crown", agreed: true, count: 2 ** 60 }],
    ["string for number", { procedure: "crown", agreed: true, amount: "3" }],
    ["NaN", { procedure: "crown", agreed: true, amount: Number.NaN }],
    ["over-long string", { procedure: "crown", agreed: true, zip: "1".repeat(1001) }],
  ])("refuses %s", (_l, args) => {
    const r = validateToolArgs(params, args);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors.length).toBeGreaterThan(0);
  });

  it("an unsafe pattern never matches (the safe grammar, no flags)", () => {
    const p: ToolParams = { type: "object", required: ["x"], properties: { x: { type: "string", pattern: "(a+)+$" } } };
    expect(validateToolArgs(p, { x: "aaa" }).ok).toBe(false);
    const cased: ToolParams = { type: "object", required: ["x"], properties: { x: { type: "string", pattern: "^[A-Z]{2}$" } } };
    expect(validateToolArgs(cased, { x: "AB" }).ok).toBe(true);
    expect(validateToolArgs(cased, { x: "ab" }).ok).toBe(false);
  });
});

describe("lookup_table parser (moved from WP16)", () => {
  const PRICES_CSV = "﻿procedure,label,deposit_usd\ncleaning,Teeth cleaning,40\ncrown,\"Crown, porcelain\",250\n\"root canal\",\"Root canal \"\"molar\"\"\",180\r\n";

  it("parses RFC 4180 CSV and looks up normalized keys", () => {
    expect(parseCsv('a,"b,c","d ""e"""\r\n1,2,3\n')).toEqual([["a", "b,c", 'd "e"'], ["1", "2", "3"]]);
    const r = parseLookupTable({ format: "csv", data: PRICES_CSV, keyColumn: "procedure" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.table.columns).toEqual(["procedure", "label", "deposit_usd"]);
    expect(lookupRow(r.table, "Root  Canal ")).toEqual({ data: { procedure: "root canal", label: 'Root canal "molar"', deposit_usd: "180" } });
    expect(lookupRow(r.table, "implant")).toEqual({ status: "not_found" });
    expect(lookupRow(r.table, { key: "crown" })).toEqual({ status: "not_found" });
  });

  it("parses JSON arrays of flat objects", () => {
    const r = parseLookupTable({ format: "json", data: JSON.stringify([{ id: "A1", price: 12.5, active: true }, { id: "B2", price: 3 }]), keyColumn: "id" });
    expect(r.ok && r.table.rows).toEqual([{ id: "A1", price: "12.5", active: "true" }, { id: "B2", price: "3", active: "" }]);
  });

  it.each([
    ["too many rows", { format: "csv", data: "k\n" + Array.from({ length: LOOKUP_LIMITS.maxRows + 1 }, (_, i) => `r${i}`).join("\n"), keyColumn: "k" }],
    ["too many columns", { format: "csv", data: "a,b,c,d,e,f,g,h,i\n1,2,3,4,5,6,7,8,9", keyColumn: "a" }],
    ["too many bytes", { format: "csv", data: "k,v\n" + "x,".padEnd(33_000, "y"), keyColumn: "k" }],
    ["missing key column", { format: "csv", data: "a,b\n1,2", keyColumn: "k" }],
    ["duplicate keys", { format: "csv", data: "k\nx\nX ", keyColumn: "k" }],
    ["ragged row", { format: "csv", data: "k,v\n1", keyColumn: "k" }],
    ["unterminated quote", { format: "csv", data: 'k\n"abc', keyColumn: "k" }],
    ["undeclared column", { format: "csv", data: "k,v\n1,2", keyColumn: "k", expectColumns: ["k"] }],
    ["JSON nested value", { format: "json", data: '[{"k":"1","v":{"x":1}}]', keyColumn: "k" }],
  ] as const)("refuses %s", (_label, i) => {
    expect(parseLookupTable(i as Parameters<typeof parseLookupTable>[0]).ok).toBe(false);
  });

  it("counts UTF-8 bytes without Node's Buffer", () => {
    expect(utf8Bytes("aé€😀")).toBe(1 + 2 + 3 + 4);
  });
});

describe("connector rule mirrors (lint S3, L2)", () => {
  it("header names the runtime drops", () => {
    for (const h of ["Host", "cookie", "Content-Type", "User-Agent", "Proxy-Foo", "Sec-Fetch-Mode", "X-Changeover-Signature", "TE"]) {
      expect(isForbiddenDeclaredHeader(h), h).toBe(true);
    }
    for (const h of ["Authorization", "X-Api-Key", "Accept"]) expect(isForbiddenDeclaredHeader(h), h).toBe(false);
  });

  it.each([
    ["https://api.example.com/hook", null],
    ["https://api.example.com:443/x", null],
    ["https://93.184.216.34/x", null],
    ["https://[2606:4700::1111]/x", null],
    ["https://api.example.com:8443/x", "port 443"],
    ["https://user:pw@api.example.com/x", "user name"],
    ["https://localhost/x", "not a public host"],
    ["https://metadata.localhost/x", "not a public host"],
    ["https://intranet/x", "single-label"],
    ["https://127.0.0.1/x", "loopback"],
    ["https://2130706433/x", "loopback"],
    ["https://169.254.169.254/latest", "link-local"],
    ["https://10.1.2.3/", "private"],
    ["https://192.168.0.10/", "private"],
    ["https://100.64.1.1/", "CGNAT"],
    ["https://[::1]/", "not global unicast"],
    ["https://[fe80::1]/", "not global unicast"],
    ["https://[2002:7f00:1::1]/", "6to4"],
    ["https://[2001:db8::1]/", "documentation"],
    ["http://api.example.com/", "https"],
  ])("%s", (url, want) => {
    const got = connectorUrlProblem(url);
    if (want === null) expect(got).toBeNull();
    else expect(got).toContain(want);
  });

  const withHttp = (mut: (c: Extract<Blueprint["connectors"][number], { type: "http_action" }>) => void) => {
    const bp = miniBlueprint();
    const c = bp.connectors[2]!;
    if (c.type === "http_action") mut(c);
    return lintBlueprint(bp).map((i) => [i.code, i.path.join(".")]);
  };

  it("S3 flags a refused URL and a dropped header", () => {
    expect(withHttp((c) => { c.url = "https://127.0.0.1/post"; })).toEqual([["S3", "connectors.2.url"]]);
    expect(withHttp((c) => { c.headers = [{ name: "Content-Type", value: "application/json" }]; })).toEqual([["S3", "connectors.2.headers.0.name"]]);
    const bp = miniBlueprint();
    bp.connectors.push({ type: "completion_webhook", id: "done_hook", label: "Done", url: "https://intranet/hook", hmacSecret: { $secret: "sec_0123456789abcdef" }, include: ["case"] });
    expect(lintBlueprint(bp).map((i) => [i.code, i.path.join(".")])).toEqual([["S3", "connectors.3.url"]]);
  });

  it("L2 loads a lookup_table connector's data against its table definition", () => {
    const bp = miniBlueprint();
    const lookup = (data: string, keyColumn = "id") => ({
      type: "lookup_table" as const, id: "prices", label: "Prices", toolName: "lookup_prices", description: "Look up a treatment price.",
      table: "treatments", keyColumn, format: "csv" as const, data,
    });
    bp.connectors.push(lookup("id,label,deposit_usd\ncleaning,Cleaning,50\nwhitening,Whitening,75\n"));
    expect(lintBlueprint(bp)).toEqual([]);
    bp.connectors[3] = lookup("id,label,price\ncleaning,Cleaning,50\n");
    expect(lintBlueprint(bp).map((i) => [i.code, i.path.join(".")])).toEqual([["L2", "connectors.3.data"]]);
    bp.connectors[3] = lookup("id,label,deposit_usd\ncleaning,Cleaning,50\n", "sku");
    expect(lintBlueprint(bp).map((i) => i.code)).toEqual(["L2", "L2"]);
  });
});

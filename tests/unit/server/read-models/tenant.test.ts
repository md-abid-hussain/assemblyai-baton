/**
 * The one tenant predicate (SAAS §6.2, §10.1 rules 1-3). WP20·1.
 *
 * This is the test that matters most in WP20: every `/app` page and every `/api/v1` read goes through
 * `casesOrgFilter`, so a mistake here is a cross-tenant read, not a layout bug. The predicate is serialized
 * with the real Postgres dialect and asserted as text + bound parameters, because "it looked right" is not a
 * property a SQL string has.
 */
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it } from "vitest";

import type { Db } from "@/server/db";
import { casesHaveOrgId, casesOrgFilter, resetSchemaProbe, visitorIdOfWorkspace } from "@/server/read-models/tenant";

const dialect = new PgDialect();
const render = (q: Awaited<ReturnType<typeof casesOrgFilter>>) => dialect.sqlToQuery(q);

/** A db whose only job is to answer the `information_schema` probe. */
function fakeDb(hasOrgId: boolean, onExecute?: (sql: string) => void): Db {
  return {
    execute: async (q: unknown) => {
      const { sql } = dialect.sqlToQuery(q as never);
      onExecute?.(sql);
      return { rows: [{ n: hasOrgId ? 1 : 0 }] };
    },
  } as unknown as Db;
}

beforeEach(() => resetSchemaProbe());

describe("visitorIdOfWorkspace", () => {
  it("unwraps ws_<vid> and rejects everything else", () => {
    expect(visitorIdOfWorkspace("ws_abc123")).toBe("abc123");
    expect(visitorIdOfWorkspace("org_abc123")).toBeNull();
    expect(visitorIdOfWorkspace("ws_")).toBeNull();
    expect(visitorIdOfWorkspace("")).toBeNull();
  });
});

describe("casesOrgFilter before 0002_saas (no cases.org_id)", () => {
  it("scopes a legacy workspace to its own visitor_id, as a bound parameter", async () => {
    const q = render(await casesOrgFilter(fakeDb(false), "ws_vid42"));
    expect(q.sql).toBe("c.visitor_id = $1");
    expect(q.params).toEqual(["vid42"]);
  });

  it("matches nothing for a real org: the column that would carry it does not exist yet", async () => {
    const q = render(await casesOrgFilter(fakeDb(false), "org_real"));
    expect(q.sql).toBe("false");
    expect(q.params).toEqual([]);
  });
});

describe("casesOrgFilter after 0002_saas", () => {
  it("scopes a real org to org_id alone and never falls back to the device", async () => {
    const q = render(await casesOrgFilter(fakeDb(true), "org_real"));
    expect(q.sql).toBe("c.org_id = $1");
    expect(q.params).toEqual(["org_real"]);
    // The shared-device rule (SAAS §2.6 R1): a real org must not pick up another person's unclaimed rows.
    expect(q.sql).not.toContain("visitor_id");
  });

  it("lets a legacy workspace still see its own not-yet-claimed rows", async () => {
    const q = render(await casesOrgFilter(fakeDb(true), "ws_vid42"));
    expect(q.sql).toBe('(c.org_id = $1 or (c.org_id is null and c.visitor_id = $2))');
    expect(q.params).toEqual(["ws_vid42", "vid42"]);
  });
});

describe("the schema probe", () => {
  it("runs once per process and is cached", async () => {
    let probes = 0;
    const db = fakeDb(true, (sql) => {
      if (sql.includes("information_schema")) probes++;
    });
    await casesOrgFilter(db, "ws_a");
    await casesOrgFilter(db, "ws_b");
    await casesOrgFilter(db, "org_c");
    expect(probes).toBe(1);
  });

  it("reads a failed probe as 'no org_id', which is the safe direction", async () => {
    const db = { execute: async () => { throw new Error("no connection"); } } as unknown as Db;
    await expect(casesHaveOrgId(db)).resolves.toBe(false);
    // A real org then matches nothing rather than every row.
    expect(render(await casesOrgFilter(db, "org_real")).sql).toBe("false");
  });
});

describe("the table alias", () => {
  it("is applied where the caller asks", async () => {
    expect(render(await casesOrgFilter(fakeDb(false), "ws_v", "cases")).sql).toBe("cases.visitor_id = $1");
  });

  it("refuses an alias that is not a plain identifier", async () => {
    await expect(casesOrgFilter(fakeDb(false), "ws_v", 'c"; drop table cases; --')).rejects.toThrow(/unsafe table alias/);
  });
});

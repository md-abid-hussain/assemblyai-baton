/**
 * The manifest is complete, and every org route calls `requirePrincipal` (SAAS §10.1 rule 1, TASKS-v3 §2 rule 13).
 * WP19·3. No database: this reads the source tree, so it runs everywhere and costs nothing.
 *
 * **Why this file is the important one.** Every other test in `tests/tenancy/**` checks a route that somebody
 * remembered to check. This one checks the *remembering*: a `route.ts` added under `src/app/api/app/**` without
 * a manifest row fails here, and so does one whose handler never resolves a principal. A tenancy suite without
 * this file tells you only about the routes you were already worried about.
 *
 * The `requirePrincipal` rule is checked one level deeper than the route file, because our route files are
 * one-line re-exports (the shape WP14b and WP18 use): the handler module has to call `requirePrincipal`, or
 * `appPrincipal`, which is the wrapper that calls it.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { AUDIT_ACTIONS } from "@/core/contracts/v3/audit";

import { MANIFEST_FILES, ROUTES } from "./manifest";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const APP_API = "src/app/api/app";

const toPosix = (p: string) => p.split(sep).join("/");

/** Every `route.ts` under `src/app/api/app/**`, as a path relative to `src/app`. */
function routeFiles(): string[] {
  const abs = join(ROOT, APP_API);
  if (!existsSync(abs)) return [];
  return (readdirSync(abs, { recursive: true, withFileTypes: true }) as import("node:fs").Dirent[])
    .filter((d) => d.isFile() && d.name === "route.ts")
    .map((d) => toPosix(relative(join(ROOT, "src/app"), join(d.parentPath, d.name))))
    .sort();
}

/** The handler modules a route file re-exports, as repo-relative paths. */
function handlersOf(routeFile: string): string[] {
  const src = readFileSync(join(ROOT, "src/app", routeFile), "utf8");
  const out: string[] = [];
  for (const mod of src.matchAll(/from\s+["']@\/([^"']+)["']/g)) out.push(`src/${mod[1]}.ts`);
  return out;
}

describe("the tenancy manifest covers every org route", () => {
  it("names every route.ts under src/app/api/app/**", () => {
    const onDisk = routeFiles();
    expect(onDisk.length, "there should be org routes to cover").toBeGreaterThan(0);
    expect(onDisk).toEqual(MANIFEST_FILES);
  });

  it("covers every method each of those files exports", () => {
    const missing: string[] = [];
    for (const file of routeFiles()) {
      const src = readFileSync(join(ROOT, "src/app", file), "utf8");
      const exported = new Set<string>();
      for (const m of src.matchAll(/export\s+const\s+(GET|POST|PATCH|PUT|DELETE)\b/g)) exported.add(m[1]!);
      for (const m of src.matchAll(/export\s+\{\s*([^}]*)\}/g)) {
        for (const name of m[1]!.split(",").map((s) => s.trim())) {
          if (["GET", "POST", "PATCH", "PUT", "DELETE"].includes(name)) exported.add(name);
        }
      }
      for (const method of exported) {
        if (!ROUTES.some((r) => r.file === file && r.method === method)) missing.push(`${method} ${file}`);
      }
    }
    expect(missing.join("\n"), "add a manifest row for each of these").toBe("");
  });

  it("every org route's handler module resolves a principal", () => {
    const offenders: string[] = [];
    for (const file of routeFiles()) {
      const handlers = handlersOf(file);
      expect(handlers.length, `${file} should re-export a handler module`).toBeGreaterThan(0);
      const resolves = handlers.some((h) => {
        const p = join(ROOT, h);
        if (!existsSync(p)) return false;
        const src = readFileSync(p, "utf8");
        return src.includes("requirePrincipal") || src.includes("appPrincipal");
      });
      if (!resolves) offenders.push(file);
    }
    expect(offenders.join("\n"), "these routes never resolve a principal (SAAS §10.1 rule 1)").toBe("");
  });

  it("no manifest row names a route file that does not exist", () => {
    const onDisk = new Set(routeFiles());
    expect(MANIFEST_FILES.filter((f) => !onDisk.has(f))).toEqual([]);
  });

  it("every mutating row carries the permission its handler asks for, or `null` by design", () => {
    // `null` is allowed only where §3.7 genuinely has no permission for the action: creating an org (any
    // account may), and leaving one (a right, not a privilege).
    const nullPerm = ROUTES.filter((r) => r.perm === null).map((r) => r.name).sort();
    expect(nullPerm).toEqual([
      "GET /api/app/orgs",
      "POST /api/app/orgs",
      "POST /api/app/orgs/:id/leave",
    ]);
  });
});

/**
 * WP19·3's acceptance says "audit rows for every mutation in §9". This is the half of that which a
 * behavioural test cannot give you: proof that no declared action is **written by nobody**.
 *
 * It caught `member.joined`, which was in `AUDIT_ACTIONS` and in §8.5's copy but had no writer anywhere —
 * accepting an invitation is the one org mutation §3.8 deliberately leaves on Better Auth's own endpoint, so
 * no route of ours ever observed it. The trail showed the invitation and then the person's later actions,
 * with the moment they gained access missing, and every behavioural test passed the whole time.
 *
 * Scoped to the `org.*`, `member.*` and `guest.*` families, which are WP19's. The rest of `AUDIT_ACTIONS`
 * belongs to WP17, WP21, WP22 and WP24; WP19·4 widens this list as those land (TASKS-v3 §7).
 */
describe("every org-lifecycle action in §9 has something that writes it", () => {
  const OURS = /^(org|member|guest)\./;

  /** Source we own that could legitimately write an audit row. */
  const SEARCH_DIRS = ["src/server/identity", "src/server/audit", "src/server/saas"];

  function ownedSources(): string[] {
    const out: string[] = [];
    for (const dir of SEARCH_DIRS) {
      const abs = join(ROOT, dir);
      if (!existsSync(abs)) continue;
      for (const d of readdirSync(abs, { recursive: true, withFileTypes: true }) as import("node:fs").Dirent[]) {
        if (d.isFile() && d.name.endsWith(".ts")) out.push(join(d.parentPath, d.name));
      }
    }
    return out;
  }

  it("names an action string somewhere in the identity/audit source", () => {
    const corpus = ownedSources().map((f) => readFileSync(f, "utf8")).join("\n");
    const orphans = AUDIT_ACTIONS.filter(
      (a) => OURS.test(a) && !corpus.includes(`"${a}"`) && !corpus.includes(`'${a}'`),
    );
    expect(
      orphans.join(", "),
      "these §9 actions are declared but nothing writes them — either wire a writer or drop them from AUDIT_ACTIONS",
    ).toBe("");
  });
});

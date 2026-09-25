// Regression guards for the Zerops deploy files (T-D1-8). Each case is a failure the first real `zcli push` hit
// (docs/notes/deploy.md); none of them shows up in a local or same-container Docker build.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const zeropsYml = readFileSync(join(ROOT, "zerops.yml"), "utf8");
const stripComments = (s: string) =>
  s
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+#.*$/, ""))
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
const yml = stripComments(zeropsYml);

describe("zerops.yml", () => {
  it("never sets HOSTNAME as an env variable (reserved by Zerops: userDataUseOfSystemKey)", () => {
    expect(yml).not.toMatch(/^\s+HOSTNAME:/m);
  });

  it("binds the standalone server to 0.0.0.0:3000 through the start command", () => {
    expect(yml).toMatch(/^\s+start: env HOSTNAME=0\.0\.0\.0 node bundle\/server\.js\s*$/m);
    expect(yml).toMatch(/^\s+PORT: "3000"$/m);
    expect(yml).toMatch(/- port: 3000\s*\n\s+httpSupport: true/);
  });

  it("writes readinessCheck timings as Go durations, retryPeriod >= 10s", () => {
    const failure = yml.match(/^\s+failureTimeout: (\S+)$/m)?.[1];
    const retry = yml.match(/^\s+retryPeriod: (\S+)$/m)?.[1];
    expect(failure).toMatch(/^\d+(s|m)$/);
    expect(retry).toMatch(/^\d+(s|m)$/);
    const secs = (d: string) => Number.parseInt(d, 10) * (d.endsWith("m") ? 60 : 1);
    expect(secs(retry ?? "0")).toBeGreaterThanOrEqual(10);
  });

  it("does not cache .next/cache (a restored cache left .next unwritable: EACCES .next/trace)", () => {
    expect(yml).not.toMatch(/^\s+- \.next\/cache$/m);
  });

  it("takes DATABASE_URL and APP_URL from Zerops references and deploys only ./bundle", () => {
    expect(yml).toContain("DATABASE_URL: ${db_connectionString}");
    expect(yml).toContain("APP_URL: ${zeropsSubdomain}");
    expect(yml).toMatch(/deployFiles:\s*\n\s+- bundle\s*\n/);
    expect(yml).toContain("- node bundle/migrate.mjs");
  });
});

describe(".deployignore", () => {
  const lines = readFileSync(join(ROOT, ".deployignore"), "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));

  it("anchors every directory pattern (unanchored node_modules/ stripped bundle/node_modules)", () => {
    for (const l of lines.filter((x) => x.endsWith("/"))) expect(l, l).toMatch(/^\//);
    expect(lines).toContain("/node_modules/");
    expect(lines).not.toContain("node_modules/");
  });

  it("keeps .env excluded at every depth", () => {
    expect(lines).toContain(".env");
    expect(lines).toContain(".env.*");
    expect(lines).toContain("!.env.example");
  });
});

describe("assemble-bundle.mjs", () => {
  const dir = mkdtempSync(join(tmpdir(), "baton-asm-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("ships no symlinks: Turbopack's .next/node_modules/<pkg>-<hash> externals become real directories", () => {
    const w = (p: string, s = "") => {
      mkdirSync(join(dir, p, ".."), { recursive: true });
      writeFileSync(join(dir, p), s);
    };
    mkdirSync(join(dir, "scripts"), { recursive: true });
    cpSync(join(ROOT, "scripts", "assemble-bundle.mjs"), join(dir, "scripts", "assemble-bundle.mjs"));
    w(".next/standalone/server.js", "// server");
    w(".next/standalone/node_modules/pg/package.json", '{"name":"pg"}');
    w(".next/standalone/node_modules/pg/lib/index.js", "module.exports = 1;");
    w(".next/static/chunks/a.js", "");
    w("drizzle/0000_init.sql", "--");
    w("dist/migrate.mjs");
    w("dist/cron.mjs");
    w(".next/standalone/.env", "SECRET=never-ship");
    mkdirSync(join(dir, ".next/standalone/.next/node_modules"), { recursive: true });
    // Absolute target, as in the Zerops build container (a junction on Windows needs no privileges).
    symlinkSync(
      join(dir, ".next/standalone/node_modules/pg"),
      join(dir, ".next/standalone/.next/node_modules/pg-587764f78a6c7a9c"),
      process.platform === "win32" ? "junction" : "dir",
    );

    execFileSync(process.execPath, [join(dir, "scripts", "assemble-bundle.mjs")], { stdio: "pipe" });

    const ext = join(dir, "bundle/.next/node_modules/pg-587764f78a6c7a9c");
    expect(lstatSync(ext).isSymbolicLink()).toBe(false);
    expect(existsSync(join(ext, "package.json"))).toBe(true);
    expect(existsSync(join(ext, "lib/index.js"))).toBe(true);
    expect(existsSync(join(dir, "bundle/server.js"))).toBe(true);
    expect(existsSync(join(dir, "bundle/.env"))).toBe(false);
    const links: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const f = join(d, e.name);
        if (lstatSync(f).isSymbolicLink()) links.push(f);
        else if (e.isDirectory()) walk(f);
      }
    };
    walk(join(dir, "bundle"));
    expect(links).toEqual([]);
  });
});

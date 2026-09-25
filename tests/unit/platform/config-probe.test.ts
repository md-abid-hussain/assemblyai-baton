/**
 * The G2 deploy probe must say which app secrets are unset by NAME and never leak a value.
 */
import { afterEach, beforeEach, expect, test } from "vitest";

import { resetEnvCache } from "@/server/env";
import { configProbe, OPTIONAL_SECRET_NAMES, REQUIRED_SECRET_NAMES } from "@/server/health/config-probe";

const saved = new Map<string, string | undefined>();

function setEnv(name: string, value: string | undefined): void {
  if (!saved.has(name)) saved.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  resetEnvCache();
}

beforeEach(() => {
  for (const n of [...REQUIRED_SECRET_NAMES, ...OPTIONAL_SECRET_NAMES]) setEnv(n, undefined);
});

afterEach(() => {
  for (const [n, v] of saved) {
    if (v === undefined) delete process.env[n];
    else process.env[n] = v;
  }
  saved.clear();
  resetEnvCache();
});

test("nothing set: every required name is reported, ok is false", () => {
  const p = configProbe();
  expect(p.ok).toBe(false);
  expect(p.missing).toEqual([...REQUIRED_SECRET_NAMES]);
  expect(p.missingOptional).toEqual([...OPTIONAL_SECRET_NAMES]);
});

test("all required set: ok, and the optional ones stay listed separately", () => {
  for (const n of REQUIRED_SECRET_NAMES) setEnv(n, `value-of-${n}`);
  const p = configProbe();
  expect(p.ok).toBe(true);
  expect(p.missing).toEqual([]);
  expect(p.missingOptional).toEqual([...OPTIONAL_SECRET_NAMES]);
  // No value reaches the probe output.
  expect(JSON.stringify(p)).not.toContain("value-of-");
});

test("one unset secret is named and only that one", () => {
  for (const n of REQUIRED_SECRET_NAMES) setEnv(n, "x");
  setEnv("CRON_SECRET", undefined);
  const p = configProbe();
  expect(p.ok).toBe(false);
  expect(p.missing).toEqual(["CRON_SECRET"]);
});

test("an empty string counts as unset (Zerops writes empty values for untouched fields)", () => {
  for (const n of REQUIRED_SECRET_NAMES) setEnv(n, "x");
  setEnv("ADMIN_KEY", "   ");
  expect(configProbe().missing).toEqual(["ADMIN_KEY"]);
});

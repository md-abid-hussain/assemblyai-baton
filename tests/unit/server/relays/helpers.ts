/**
 * WP14b relay test fixtures: a stub gallery (the WP14a mini blueprint as "Dental deposit" with two Try-an-edit presets,
 * and a flagship stand-in until WP14a·2 ships data/relays/baton-add-driver.json), request builders and env secrets.
 */
import type { SQL } from "drizzle-orm";

import type { RelayPresetDef } from "@/core/contracts/ext/wp14b-relays";
import type { Blueprint } from "@/core/contracts/v2";
import type { Db } from "@/server/db/client";
import type { GalleryEntry } from "@/server/relays/seed";
import { miniBlueprint } from "../../core/relay/fixtures/mini-blueprint";

export const SECRETS = { VISITOR_SECRET: "test-visitor-secret-0123456789abcdef", CASE_TOKEN_SECRET: "test-case-token-secret-0123456789abcdef" };

export function dentalBlueprint(): Blueprint {
  const bp = miniBlueprint();
  bp.meta.slug = "dental-deposit";
  bp.meta.title = "Dental deposit";
  return bp;
}

export function flagshipStub(): Blueprint {
  const bp = miniBlueprint();
  bp.meta.slug = "baton-add-driver";
  bp.meta.title = "Baton: add a driver";
  bp.meta.industry = "insurance";
  return bp;
}

export const DENTAL_PRESETS: RelayPresetDef[] = [
  { id: "deposit_75", label: "Deposit $75", patch: [{ op: "replace", path: "/context/samples/0/tables/treatments/0/deposit_usd", value: "75.00" }] },
  {
    id: "add_insurer", label: "Ask for the insurer",
    patch: [{
      op: "add", path: "/fields/-",
      value: {
        id: "insurer", label: "Insurer", description: "The patient's dental insurer.", type: "text", normalizer: "text",
        required: false, setBy: "ai_allowed", adviceDomain: false, promptVisibility: "when_known", validation: {}, examples: ["Delta Dental"],
        compare: "exact", display: "raw", capture: { priority: 5, mode: "balanced", entity: false },
        phrases: { ask: "your dental insurer", confirm: "your insurer is {f.insurer.display}" }, qa: { ask: ["\\binsur\\w*\\b"], weak: [] },
        ui: { group: null, hidden: false },
      },
    }],
  },
];

export function galleryEntries(): GalleryEntry[] {
  return [
    { file: "baton-add-driver.json", json: flagshipStub(), presets: [] },
    { file: "dental-deposit.json", json: dentalBlueprint(), presets: DENTAL_PRESETS },
  ];
}

const BASE = "http://localhost";
export type Headers_ = Record<string, string>;

export const req = (method: string, url: string, body?: unknown, headers: Headers_ = {}) =>
  new Request(`${BASE}${url}`, {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7", ...headers },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });

export const ctxOf = (id: string) => ({ params: Promise.resolve({ id }) });

export function withSecrets(): () => void {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(SECRETS)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

/** The first column of the first row of a `select count(*)::int as n ...`-style query. */
export async function scalar(db: Db, q: SQL): Promise<number> {
  const row = (await db.execute(q)).rows[0] as Record<string, unknown> | undefined;
  return Number(row ? Object.values(row)[0] : NaN);
}

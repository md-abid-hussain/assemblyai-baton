import { NextResponse } from "next/server";

import { versionString } from "@/lib/version";
import { pingDb } from "@/server/db";
import { missingEnv } from "@/server/env";
import { configProbe } from "@/server/health/config-probe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Route #1 `GET /api/health` (DESIGN §4.4, §7.7): liveness only, used by the Zerops healthCheck and
 * readinessCheck. A DB `select 1` and the env the process cannot start without. No external calls.
 * 200 `{ok:true, db:true, version}` when healthy, otherwise 503 with the same shape (never env values).
 *
 * G2 (WP12): `?probe=config` adds `config: {ok, missing, missingOptional}`, the NAMES of the app secrets that are
 * unset on this deployment. It is opt-in so the default body (and the Zerops readiness check) is unchanged, and it
 * exists because zcli cannot read a service's env and the values must never be printed.
 */
export async function GET(req: Request): Promise<NextResponse> {
  let envOk = false;
  try {
    envOk = missingEnv(["DATABASE_URL"]).length === 0;
  } catch {
    envOk = false; // an invalid value: EnvError (names only) — report unhealthy, never echo it
  }
  const db = envOk ? await pingDb() : false;
  const ok = envOk && db;
  const wantConfig = new URL(req.url).searchParams.get("probe") === "config";
  return NextResponse.json(
    { ok, db, version: versionString(process.env), ...(wantConfig ? { config: configProbe() } : {}) },
    { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}

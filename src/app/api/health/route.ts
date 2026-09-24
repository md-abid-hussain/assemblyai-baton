import { NextResponse } from "next/server";

import { versionString } from "@/lib/version";
import { pingDb } from "@/server/db";
import { missingEnv } from "@/server/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Route #1 `GET /api/health` (DESIGN §4.4, §7.7): liveness only, used by the Zerops healthCheck and
 * readinessCheck. A DB `select 1` and the env the process cannot start without. No external calls.
 * 200 `{ok:true, db:true, version}` when healthy, otherwise 503 with the same shape (never env values).
 */
export async function GET(): Promise<NextResponse> {
  let envOk = false;
  try {
    envOk = missingEnv(["DATABASE_URL"]).length === 0;
  } catch {
    envOk = false; // an invalid value: EnvError (names only) — report unhealthy, never echo it
  }
  const db = envOk ? await pingDb() : false;
  const ok = envOk && db;
  return NextResponse.json(
    { ok, db, version: versionString(process.env) },
    { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}

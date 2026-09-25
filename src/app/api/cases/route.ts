import { CreateCaseRequestV2Schema } from "@/core/contracts/v2";
import { CASE_RATES, getCasesDeps } from "@/server/cases";
import { createCase } from "@/server/cases/create";
import { enforce, json, readBody, route } from "@/server/cases/http";
import { getRelaysDeps } from "@/server/relays";

/**
 * #3 POST /api/cases (DESIGN §4.4): visitor auth; 10/h/visitor, 30/h/ipKey (the v2 `run` bucket, PLATFORM §10.2).
 * v2: `relayId` / `relayVersionId` run a relay version (`src/server/cases/create.ts`).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = route("cases.create", async (req: Request) => {
  const d = getCasesDeps();
  const visitor = d.platform.requireVisitor(req);
  const body = await readBody(req, CreateCaseRequestV2Schema);
  await enforce(d.platform.rateLimiter(), [
    { ...CASE_RATES.createVisitor, key: visitor.visitorId, message: "Too many calls started from this browser in the last hour. Try again later." },
    { ...CASE_RATES.createIp, key: visitor.ipKey, message: "Too many calls started from this network in the last hour. Try again later." },
  ]);
  return json(await createCase({ ...d, relays: () => getRelaysDeps() }, body, visitor));
});

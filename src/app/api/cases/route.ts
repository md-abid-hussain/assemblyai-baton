import { CreateCaseRequestSchema } from "@/core/contracts/api";
import { CASE_RATES, getCasesDeps } from "@/server/cases";
import { createCase } from "@/server/cases/create";
import { enforce, json, readBody, route } from "@/server/cases/http";

/** #3 POST /api/cases (DESIGN §4.4): visitor auth; 10/h/visitor, 30/h/ipKey. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = route("cases.create", async (req: Request) => {
  const d = getCasesDeps();
  const visitor = d.platform.requireVisitor(req);
  const body = await readBody(req, CreateCaseRequestSchema);
  await enforce(d.platform.rateLimiter(), [
    { ...CASE_RATES.createVisitor, key: visitor.visitorId, message: "Too many calls started from this browser in the last hour. Try again later." },
    { ...CASE_RATES.createIp, key: visitor.ipKey, message: "Too many calls started from this network in the last hour. Try again later." },
  ]);
  return json(await createCase(d, body, visitor));
});

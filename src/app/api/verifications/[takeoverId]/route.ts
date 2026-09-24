import { handleVerificationGet } from "@/server/qa/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Route #20 `GET /api/verifications/[takeoverId]` (DESIGN §4.4): takeover token, 1/s → `VerificationView`
 * `{status, qa, elapsedMs, reason?}`. Advances the `verify_takeover` job one step when it is due (portable background).
 */
export async function GET(req: Request, ctx: { params: Promise<{ takeoverId: string }> }): Promise<Response> {
  const { takeoverId } = await ctx.params;
  return handleVerificationGet(req, takeoverId);
}

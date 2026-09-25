import { NextResponse, type NextRequest } from "next/server";

import {
  newVisitorId, readCookie, signVisitorId, verifyVisitorValue, VISITOR_COOKIE, VISITOR_COOKIE_MAX_AGE_S,
} from "./server/auth/visitor";

/**
 * Next 16 proxy (formerly middleware; Node.js runtime by default). DESIGN §4.3: set the signed visitor cookie `bvid`
 * on the first request. The new cookie is also injected into THIS request's Cookie header, so a route handler hit
 * by a first-time visitor already sees its identity. Security headers are set in next.config.mjs (§8.4).
 *
 * No secret configured (a misconfigured deploy) → pass through untouched; routes then fail closed on their own.
 */
export function proxy(request: NextRequest): NextResponse {
  const secret = process.env.VISITOR_SECRET?.trim();
  if (!secret) return NextResponse.next();

  const cookieHeader = request.headers.get("cookie");
  if (verifyVisitorValue(readCookie(cookieHeader, VISITOR_COOKIE), secret)) return NextResponse.next();

  const value = signVisitorId(newVisitorId(), secret);
  const headers = new Headers(request.headers);
  const others = (cookieHeader ?? "")
    .split(";")
    .map((p) => p.trim())
    .filter((p) => p && !p.startsWith(`${VISITOR_COOKIE}=`));
  headers.set("cookie", [...others, `${VISITOR_COOKIE}=${encodeURIComponent(value)}`].join("; "));

  const res = NextResponse.next({ request: { headers } });
  res.cookies.set({
    name: VISITOR_COOKIE,
    value,
    path: "/",
    maxAge: VISITOR_COOKIE_MAX_AGE_S,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
  return res;
}

export const config = {
  // Pages and API routes; not static assets, call audio, fixtures or data files.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|calls/|fixtures/|data/|replays/|tts/|.*\\.(?:png|jpg|svg|ico|json|ulaw|pcm16|wav|ogg|webm|js|css|map|txt)$).*)"],
};

import { redirect } from "next/navigation";

import { lookupCall } from "./call-entry";

// The manifest (src/generated/calls.json, WP9) is read per request: never freeze a build-time redirect.
export const dynamic = "force-dynamic";

/** /call → the featured call (DESIGN §1.3 P1), or the fixture console while the manifest does not exist yet. */
export default async function CallIndex() {
  const { featuredId } = await lookupCall(null);
  redirect(featuredId ? `/call/${encodeURIComponent(featuredId)}?mode=watch` : "/dev/ui");
}

import { redirect } from "next/navigation";

import { lookupCall } from "./call-entry";

/** /call → the featured call (DESIGN §1.3 P1), or the fixture console while the manifest does not exist yet. */
export default async function CallIndex() {
  const { featuredId } = await lookupCall(null);
  redirect(featuredId ? `/call/${encodeURIComponent(featuredId)}?mode=watch` : "/dev/ui");
}

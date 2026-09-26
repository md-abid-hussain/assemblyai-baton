import type { Metadata } from "next";

import { RelaysList } from "@/components/studio/relays-list";
import { appPrincipal } from "@/server/read-models/app-guard";

import { studioEnv } from "./studio-config";

/**
 * `/app/relays` — the relays list (SAAS §5.5). `/studio` 308s here.
 *
 * G3: the principal is resolved here even though the list itself is fetched client-side, so a visitor with no
 * session is sent to `/start` and comes back with a workspace (TASKS-v3 §2 rule 13). Without it the page
 * rendered its chrome and every fetch inside it answered 401.
 */
export const metadata: Metadata = { title: "Relays · Changeover Studio" };
export const dynamic = "force-dynamic";

export default async function RelaysPage() {
  await appPrincipal("/app/relays");
  return <RelaysList env={studioEnv()} />;
}

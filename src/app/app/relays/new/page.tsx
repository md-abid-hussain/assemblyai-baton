import type { Metadata } from "next";

import { NewRelay } from "@/components/studio/new-relay";
import { appPrincipal } from "@/server/read-models/app-guard";

import { studioEnv } from "../studio-config";

/** `/app/relays/new` — the template picker and the blank relay (SAAS §5.5). */
export const metadata: Metadata = { title: "New relay · Changeover Studio" };
export const dynamic = "force-dynamic";

export default async function NewRelayPage() {
  await appPrincipal("/app/relays/new");   // creating a relay needs a workspace to create it in
  return <NewRelay env={studioEnv()} />;
}

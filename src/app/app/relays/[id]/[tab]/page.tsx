import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { isStudioTab } from "@/components/studio/tabs";
import { EditorShell } from "@/components/studio/editor-shell";
import { appPrincipal } from "@/server/read-models/app-guard";

import { studioEnv } from "../../studio-config";

/** `/app/relays/:id/:tab` — the editor shell (SAAS §5.5). */
export const metadata: Metadata = { title: "Changeover Studio" };
export const dynamic = "force-dynamic";

export default async function RelayTabPage({ params }: { params: Promise<{ id: string; tab: string }> }) {
  const { id, tab } = await params;
  if (!isStudioTab(tab)) notFound();
  // The relay itself is still fetched (and tenant-checked) by `/api/relays/:id`; this only guarantees the
  // page is rendered for a principal at all, so a session-less visitor gets `/start` rather than a dead shell.
  await appPrincipal(`/app/relays/${encodeURIComponent(id)}/${tab}`);
  return <EditorShell relayId={decodeURIComponent(id)} tab={tab} env={studioEnv()} />;
}

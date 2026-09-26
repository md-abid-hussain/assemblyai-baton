import { redirect } from "next/navigation";

import { DEFAULT_TAB } from "@/components/studio/tabs";

/** `/app/relays/:id` → the default tab. A 307, not a 308: the default tab may move between units. */
export default async function RelayPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/app/relays/${encodeURIComponent(id)}/${DEFAULT_TAB}`);
}

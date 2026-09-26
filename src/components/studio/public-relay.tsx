"use client";
/**
 * components/studio/public-relay.tsx - `/r/[slug]`, the read-only relay page (PLATFORM §7.1).
 *
 * WP15·4 owns this page properly (the "Run a simulated call" card and the quota copy). What it needs from WP15·1 is
 * to **exist**: the relays list links gallery cards here, and a Run button that 404s is worse than one that lands on
 * an honest read-only page. So this is the page minus the run: the banner, the compiled preview, the source, and a
 * way into the Studio.
 *
 * **The mic is never enabled here** (P§7.1), and nothing on this page can start one.
 */
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import { sourceOf, StudioApi } from "@/client/studio/api";
import { BLUEPRINT_SCHEMA_PATH } from "@/client/studio/capabilities";
import { createSourceStore, type SourceStore } from "@/client/studio/source-store";
import { SourceStoreProvider } from "@/client/studio/use-source-store";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { RelayDetail } from "@/core/contracts/v2";

import { PreviewPanel } from "./preview-panel";

const NO_SAVE = async () => ({ ok: false as const, message: "This page is read-only." });

export function PublicRelay({ slug }: { slug: string }) {
  const api = useMemo(() => new StudioApi(), []);
  const [detail, setDetail] = useState<RelayDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const storeRef = useRef<SourceStore | null>(null);

  useEffect(() => {
    let alive = true;
    api.get(slug).then(
      (d) => {
        if (!alive) return;
        setDetail(d);
        storeRef.current = createSourceStore({
          relayId: d.id,
          text: sourceOf(d.draft, "yaml", BLUEPRINT_SCHEMA_PATH),
          format: "yaml",
          rev: d.draftRev,
          readOnly: true,
          flagship: d.flagship,
          deps: { save: NO_SAVE, storage: null },
        });
      },
      (e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      alive = false;
      storeRef.current?.getState().dispose();
    };
  }, [api, slug]);

  if (error) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-12">
        <h1 className="text-lg font-semibold">This relay is not available</h1>
        <p className="text-muted-foreground mt-2 text-sm">{error}</p>
      </main>
    );
  }
  if (!detail || !storeRef.current) return <p className="text-muted-foreground p-6 text-sm">Loading…</p>;

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-6">
      {!detail.flagship ? (
        <p className="mb-4 rounded-md border bg-amber-50 px-3 py-2 text-sm dark:bg-amber-950/40">
          User-made relay · fictional business.
        </p>
      ) : null}
      <div className="flex flex-wrap items-baseline gap-2">
        <h1 className="text-xl font-semibold">{detail.title}</h1>
        {detail.flagship ? <Badge>Flagship</Badge> : null}
        <Badge variant="outline">{detail.industry}</Badge>
      </div>
      <p className="text-muted-foreground mt-2 text-sm">
        A relay agent: a human starts the call, then hands it over with the case already built. This is what the AI
        inherits.
      </p>
      <div className="mt-4 flex gap-2">
        <Button type="button" size="sm" variant="outline" asChild>
          <Link href={`/app/relays/${encodeURIComponent(detail.id)}/code`}>View the blueprint in Studio</Link>
        </Button>
      </div>

      <SourceStoreProvider store={storeRef.current}>
        <div className="mt-6 rounded-xl border">
          <PreviewPanel />
        </div>
      </SourceStoreProvider>
    </main>
  );
}

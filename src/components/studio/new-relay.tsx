"use client";
/**
 * components/studio/new-relay.tsx - `/app/relays/new` (SAAS §5.5).
 *
 * A template picker or a blank relay, and nothing else: "Describe your desk" is §5.9 and P4 (WP15·4), and it will
 * land here as a third option that opens on the **Code** tab with its drafting notes as a comment block — not as a
 * separate wizard route.
 */
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { StudioApi } from "@/client/studio/api";
import { configFrom, type StudioEnvProps } from "@/client/studio/capabilities";
import { Button } from "@/components/ui/button";
import { INDUSTRIES, type ListRelaysResponse } from "@/core/contracts/v2";

const INDUSTRY_LABEL: Record<string, string> = {
  insurance: "Insurance",
  healthcare: "Healthcare",
  telecom: "Telecom",
  utilities: "Utilities",
  financial_services: "Financial services",
  retail: "Retail",
  other: "Other",
};

export function NewRelay({ env }: { env: StudioEnvProps }) {
  const api = useMemo(() => new StudioApi(), []);
  const config = useMemo(() => configFrom(env), [env]);
  const [gallery, setGallery] = useState<ListRelaysResponse["gallery"]>([]);
  const [industry, setIndustry] = useState<string>("other");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.list().then(
      (d) => alive && setGallery(d.gallery),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [api]);

  const go = async (body: Parameters<StudioApi["create"]>[0]) => {
    setBusy(true);
    setError(null);
    try {
      const created = await api.create(body);
      window.location.href = `/app/relays/${encodeURIComponent(created.id)}/code`;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  if (config.mode === "readonly") {
    return (
      <main className="mx-auto max-w-2xl px-4 py-12">
        <h1 className="text-lg font-semibold">New relays are off on this deployment</h1>
        <p className="text-muted-foreground mt-2 text-sm">
          You can still read, preview and download every relay.{" "}
          <Link href="/app/relays" className="underline underline-offset-4">
            Back to relays
          </Link>
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-6">
      <nav aria-label="Breadcrumb" className="text-muted-foreground text-sm">
        <Link href="/app/relays" className="underline underline-offset-4">
          Changeover Studio
        </Link>{" "}
        / New relay
      </nav>
      <h1 className="mt-2 text-xl font-semibold">New relay</h1>
      <p className="text-muted-foreground mt-2 text-sm">
        Start from a template and edit it, or start blank. Either way you get one blueprint file you can edit in the
        forms, in Code, or in your own editor through the CLI.
      </p>
      {error ? <p className="text-destructive mt-3 text-sm">{error}</p> : null}

      <section className="mt-6">
        <h2 className="text-sm font-semibold tracking-wide uppercase">From a template</h2>
        <ul className="mt-3 grid gap-3 sm:grid-cols-2">
          {gallery.map((r) => (
            <li key={r.id} className="flex flex-col gap-2 rounded-xl border p-4">
              <h3 className="text-sm font-semibold">{r.title}</h3>
              <p className="text-muted-foreground text-xs">{INDUSTRY_LABEL[r.industry] ?? r.industry}</p>
              <Button type="button" size="sm" className="mt-1 w-fit" disabled={busy} onClick={() => void go({ kind: "clone", relayId: r.id })}>
                Use template
              </Button>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-6">
        <h2 className="text-sm font-semibold tracking-wide uppercase">Blank</h2>
        <div className="mt-3 flex flex-wrap items-end gap-3 rounded-xl border p-4">
          <label className="text-sm">
            <span className="mb-1 block font-medium">Industry</span>
            <select
              value={industry}
              onChange={(e) => setIndustry(e.target.value)}
              className="focus-visible:ring-ring/50 rounded-md border px-2 py-1.5 text-sm focus-visible:ring-2 focus-visible:outline-none"
            >
              {INDUSTRIES.map((i) => (
                <option key={i} value={i}>
                  {INDUSTRY_LABEL[i] ?? i}
                </option>
              ))}
            </select>
          </label>
          <Button type="button" disabled={busy} onClick={() => void go({ kind: "blank", industry })}>
            Create a blank relay
          </Button>
        </div>
      </section>
    </main>
  );
}

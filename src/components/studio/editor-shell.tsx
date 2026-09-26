"use client";
/**
 * components/studio/editor-shell.tsx - `/app/relays/[id]/[tab]` (SAAS §5.5).
 *
 * The shell owns exactly three things and delegates everything else: it loads the relay, it builds the one source
 * store the whole editor reads, and it lays out the top bar, the tab strip, the tab body and the docked Preview.
 *
 * Preview docks to the right of Configure and Code at ≥ 1280 px and is a tab of its own below that, so the same
 * component serves both and there is no second implementation to keep in step.
 *
 * The tabs this unit does not build render a scheduled-work panel rather than a blank one — see `tabs.ts`.
 */
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import { StudioApi, downloadName, sourceOf } from "@/client/studio/api";
import { capabilitiesFor, configFrom, type StudioEnvProps } from "@/client/studio/capabilities";
import { createSourceStore, type SourceStore } from "@/client/studio/source-store";
import { DEFAULT_TAB, DOCKS_PREVIEW, visibleTabs, type StudioTab } from "@/components/studio/tabs";
import { SourceStoreProvider, useSource, useSourceActions } from "@/client/studio/use-source-store";
import { Button } from "@/components/ui/button";
import type { RelayDetail } from "@/core/contracts/v2";
import { unifiedDiff, type SourceFormat } from "@/core/relay-code";
import { cn } from "@/lib/utils";

import { CodeTab } from "./code-tab";
import { ConfigureTab } from "./configure/configure-tab";
import { EditorTopBar } from "./editor-top-bar";
import { ImportDialog } from "./import-dialog";
import { OverviewTab } from "./overview-tab";
import { PreviewPanel } from "./preview-panel";

export interface EditorShellProps {
  relayId: string;
  tab: StudioTab;
  env: StudioEnvProps;
}

export function EditorShell({ relayId, tab, env }: EditorShellProps) {
  const api = useMemo(() => new StudioApi(), []);
  const config = useMemo(() => configFrom(env), [env]);
  const [detail, setDetail] = useState<RelayDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const storeRef = useRef<SourceStore | null>(null);

  useEffect(() => {
    let alive = true;
    api.get(relayId).then(
      (d) => {
        if (!alive) return;
        setDetail(d);
        storeRef.current?.getState().dispose();
        storeRef.current = createSourceStore({
          relayId: d.id,
          text: sourceOf(d.draft, "yaml", config.schemaUrl),
          format: "yaml",
          rev: d.draftRev,
          readOnly: d.readOnly || config.mode === "readonly",
          flagship: d.flagship,
          deps: { save: api.save },
        });
      },
      (e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      alive = false;
      storeRef.current?.getState().dispose();
    };
  }, [api, relayId, config.schemaUrl, config.mode]);

  if (error) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-12">
        <h1 className="text-lg font-semibold">This relay could not be opened</h1>
        <p className="text-muted-foreground mt-2 text-sm">{error}</p>
        <p className="mt-4 text-sm">
          <Link href="/app/relays" className="underline underline-offset-4">
            Back to your relays
          </Link>
        </p>
      </main>
    );
  }
  if (!detail || !storeRef.current) {
    return <p className="text-muted-foreground p-6 text-sm">Opening the relay…</p>;
  }

  return (
    <SourceStoreProvider store={storeRef.current}>
      <EditorBody detail={detail} tab={tab} config={config} api={api} />
    </SourceStoreProvider>
  );
}

function EditorBody({ detail, tab, config, api }: { detail: RelayDetail; tab: StudioTab; config: ReturnType<typeof configFrom>; api: StudioApi }) {
  const caps = capabilitiesFor({ mode: config.mode, relayReadOnly: detail.readOnly });
  const tabs = visibleTabs(caps);
  const active = tabs.some((t) => t.id === tab) ? tab : DEFAULT_TAB;
  const [importOpen, setImportOpen] = useState(false);
  const [versionNote, setVersionNote] = useState<string | null>(null);
  const actions = useSourceActions();
  const text = useSource((s) => s.text);
  const format = useSource((s) => s.format);

  /** Save the draft first, then snapshot it: a version of text the server never saw would be a lie. */
  const saveVersion = async () => {
    setVersionNote(null);
    await actions.saveNow();
    try {
      const v = await api.snapshot(detail.id);
      setVersionNote(v.created ? `Saved version ${v.version}.` : `No change since version ${v.version}.`);
    } catch (e) {
      setVersionNote(e instanceof Error ? e.message : String(e));
    }
  };

  const download = () => {
    const blob = new Blob([text], { type: format === "json" ? "application/json" : "text/yaml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = downloadName(detail.slug, format);
    a.click();
    URL.revokeObjectURL(url);
  };

  const docked = DOCKS_PREVIEW.includes(active);

  return (
    <div className="flex h-dvh min-h-0 flex-col">
      <EditorTopBar
        relayId={detail.id}
        slug={detail.slug}
        title={detail.title}
        caps={caps}
        onSaveVersion={caps.canEdit ? () => void saveVersion() : undefined}
      />
      {versionNote ? <p className="bg-muted/50 border-b px-4 py-1.5 text-xs">{versionNote}</p> : null}

      <RestorePrompt />
      <ConflictPrompt />
      {detail.readOnly ? (
        <p className="bg-muted/50 border-b px-4 py-1.5 text-xs">
          {detail.flagship ? "Flagship · read-only." : "Read-only."} {caps.canClone ? "Clone it to edit." : null}
        </p>
      ) : null}
      {config.mode === "readonly" ? (
        <p className="bg-muted/50 border-b px-4 py-1.5 text-xs">
          This deployment is in read-only mode: you can read and download the blueprint, but not edit, test or publish.
        </p>
      ) : null}

      <nav aria-label="Relay editor" className="flex gap-1 overflow-x-auto border-b px-2 py-1">
        {tabs.map((t) => (
          <Link
            key={t.id}
            href={`/app/relays/${encodeURIComponent(detail.id)}/${t.id}`}
            aria-current={t.id === active ? "page" : undefined}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm whitespace-nowrap",
              t.id === active ? "bg-accent text-accent-foreground font-medium" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      <div className={cn("min-h-0 flex-1", docked && "xl:grid xl:grid-cols-[minmax(0,1fr)_420px]")}>
        {/*
          `h-full` is load-bearing below 1280 px. The parent is `flex-1` of an `h-dvh` column, so it has a real
          height, but it is a plain BLOCK until `xl:grid` kicks in — and a block child sizes to its content, which
          collapsed Monaco (`height="100%"`) to a few pixels. Above 1280 px the grid would stretch this on its own;
          `h-full` is correct in both, and is what makes the editor fill the viewport at 1024 px and at 390 px.
        */}
        <div className="h-full min-h-0 overflow-hidden">
          {active === "overview" ? (
            <OverviewTab relayId={detail.id} />
          ) : active === "configure" ? (
            <ConfigureTab relayId={detail.id} canEdit={caps.canEdit} plan={config.plan} />
          ) : active === "code" ? (
            <CodeTab
              schemaUrl={config.schemaUrl}
              monacoVsPath={config.monacoVsPath}
              editor={config.editor}
              readOnly={!caps.canEdit}
              onImport={() => setImportOpen(true)}
              onDownload={download}
            />
          ) : active === "preview" ? (
            <PreviewPanel className="h-full" />
          ) : (
            <ScheduledTab tab={active} />
          )}
        </div>
        {docked ? <PreviewPanel className="hidden h-full border-l xl:block" /> : null}
      </div>

      <ImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        mode="replace"
        currentText={text}
        onConfirm={({ text: next, format: fmt }) => actions.replaceText(next, fmt)}
      />
    </div>
  );
}

/** The reload prompt (SAAS §5.5: a per-viewer copy of the unsaved text, restored with a prompt). */
function RestorePrompt() {
  const restorable = useSource((s) => s.restorable);
  const actions = useSourceActions();
  if (restorable === null) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 border-b bg-amber-50 px-4 py-2 text-sm dark:bg-amber-950/40">
      <span>You have unsaved changes to this relay from an earlier session in this browser.</span>
      <Button type="button" size="sm" variant="outline" onClick={() => actions.restoreLocal()}>
        Restore them
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => actions.discardLocal()}>
        Discard
      </Button>
    </div>
  );
}

/**
 * The 409 prompt. SAAS §5.5 gives it Monaco's diff editor; until the Versions tab brings that in (WP15·3), it shows
 * the same comparison as a unified diff, which is the codec's own `unifiedDiff` and needs no editor at all.
 */
function ConflictPrompt() {
  const conflict = useSource((s) => s.conflict);
  const mine = useSource((s) => s.text);
  const actions = useSourceActions();
  if (!conflict) return null;
  const diff = conflict.theirText !== null ? unifiedDiff(conflict.theirText, mine, { a: `rev ${conflict.theirRev}`, b: "yours" }) : "";
  return (
    <div className="border-b bg-amber-50 px-4 py-2 text-sm dark:bg-amber-950/40">
      <p className="font-medium">This relay was saved elsewhere (now at rev {conflict.theirRev}).</p>
      {diff ? (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs">What is different</summary>
          <pre className="bg-background/60 mt-1 max-h-48 overflow-auto rounded p-2 font-mono text-xs">{diff}</pre>
        </details>
      ) : null}
      <div className="mt-2 flex gap-2">
        <Button type="button" size="sm" variant="outline" onClick={() => actions.resolveConflict("mine")}>
          Keep mine
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={conflict.theirText === null} onClick={() => actions.resolveConflict("theirs")}>
          Take theirs
        </Button>
      </div>
    </div>
  );
}

const UNIT_COPY: Record<string, string> = {
  versions: "The version list, snapshot, restore and the diff editor arrive with WP15·3.",
  test: "The call picker, the run plan and the embedded console arrive with WP15·3.",
  publish: "Publishing and the API, SDK and CLI snippets arrive with WP15·3.",
  analytics: "The Recorded/Simulated tiles and the runs table arrive with WP15·4.",
};

function ScheduledTab({ tab }: { tab: StudioTab }) {
  return (
    <div className="text-muted-foreground p-6 text-sm">
      <p>{UNIT_COPY[tab] ?? "This tab is not built yet."}</p>
      <p className="mt-2">
        Everything this relay does is already in{" "}
        <span className="text-foreground font-medium">Code</span>, and the compiled result is in{" "}
        <span className="text-foreground font-medium">Preview</span>.
      </p>
    </div>
  );
}

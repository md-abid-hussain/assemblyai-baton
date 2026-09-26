"use client";
/**
 * CallConsole (DESIGN §1.4 S2): the whole call page, driven only by the console store.
 * - ≥1280 px: three columns (Transcript 38% · Case 36% · Controls 26%) plus the bottom timeline, fitted to the viewport.
 * - 768–1279 px: Case + Transcript on the left, a sticky control column on the right; the page scrolls.
 * - <768 px: tabs "Call | Case | Phone", a sticky bottom bar with Pass the baton, the HUD collapsed into the top bar.
 * The phone floats bottom-right from `phone.sms` onwards below 1600 px, and docks in the right column at ≥1600 px.
 */
import "../layout/console.css";

import { MessagesSquareIcon, NotebookTabsIcon, SmartphoneIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useBaton } from "@/client/store/hooks";
import { isRecordedAi } from "@/client/store/selectors";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import { CaseCard } from "../case/case-card";
import { useMinWidth } from "../common/console-context";
import { CallTimeline } from "./call-timeline";
import { ControlPanelBody, PassButton } from "./control-panel";
import { DockedPhone, FloatingPhone } from "./phone-dock";
import { ProvenanceStrip } from "./provenance-strip";
import {
  AudioLockedOverlay, CallEndedCard, ConnectingCard, HandBackCard, PausedOverlay, PreflightCard, QaSheet, QueuedCard, RecordedAiNote,
} from "./state-cards";
import { Banners, NarratorStrip, TopBar } from "./top-bar";
import { TranscriptLanes } from "./transcript-lanes";

export function ControlColumn({ showDockedPhone }: { showDockedPhone: boolean }) {
  const phase = useBaton((s) => s.flowPhase);
  const loadFailed = useBaton((s) => s.phase === "error" && !s.context);
  const ended = useBaton((s) => s.callEnded);
  const recordedPlan = useBaton((s) => s.plan?.aiHalf === "recorded" && s.takeover.phase === "idle");
  const hasSms = useBaton((s) => s.phone.sms.length > 0);
  return (
    <div className="space-y-4">
      {phase === "preflight" ? (
        <p className="text-sm text-(--bt-muted)">
          {loadFailed ? "The call did not load, so there is nothing to start yet." : "Choose Express or the full call to start. The Pass button appears here."}
        </p>
      ) : phase === "queued" ? (
        <QueuedCard />
      ) : phase === "connecting" ? (
        <ConnectingCard />
      ) : (
        <ControlPanelBody />
      )}
      {phase === "handed-back" ? <HandBackCard /> : null}
      {ended && phase === "shadowing" ? <CallEndedCard /> : null}
      {recordedPlan && phase === "shadowing" ? <RecordedAiNote /> : null}
      <QaSheet />
      {showDockedPhone && hasSms ? <DockedPhone className="h-[500px]" /> : null}
    </div>
  );
}

function PreflightOverlay() {
  const phase = useBaton((s) => s.phase);
  if (phase !== "preflight") return null;
  return (
    <div className="absolute inset-0 z-30 flex items-start justify-center overflow-y-auto bg-(--bt-bg)/55 p-4 pt-[8vh] backdrop-blur-[3px]">
      <PreflightCard />
    </div>
  );
}

type Tab = "call" | "case" | "phone";

function MobileConsole() {
  const [tab, setTab] = useState<Tab>("call");
  const phonePanel = useRef<HTMLDivElement>(null);
  const smsCount = useBaton((s) => s.phone.sms.length);
  const phase = useBaton((s) => s.flowPhase);
  const passVisible = phase === "shadowing" || phase === "handed-back";
  const recorded = useBaton(isRecordedAi);
  const paid = useBaton((s) => s.phone.state === "paid");
  const done = phase === "completed" || phase === "handed-back";
  useEffect(() => {
    if (smsCount > 0) setTab("phone"); // DESIGN §7.6: the Phone tab opens by itself on phone.sms
  }, [smsCount]);
  useEffect(() => {
    // Paid: back to the call after a beat, so the AI's closing lines are in view (the Phone tab stays one tap away).
    if (!paid) return;
    const id = setTimeout(() => setTab((t) => (t === "phone" ? "call" : t)), 3000);
    return () => clearTimeout(id);
  }, [paid]);
  useEffect(() => {
    // The QA card lives in the Call tab: the end of the pass always brings it into view.
    if (done) setTab("call");
  }, [done]);
  useEffect(() => {
    // The whole phone in view (under the sticky tabs) whenever the Phone tab opens.
    if (tab !== "phone") return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    phonePanel.current?.scrollIntoView({ block: "end", behavior: reduce ? "auto" : "smooth" });
  }, [tab]);
  const tabs: { id: Tab; label: string; Icon: typeof SmartphoneIcon }[] = [
    { id: "call", label: "Call", Icon: MessagesSquareIcon },
    { id: "case", label: "Case", Icon: NotebookTabsIcon },
    { id: "phone", label: "Phone", Icon: SmartphoneIcon },
  ];
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div role="tablist" aria-label="Console sections" className="sticky top-0 z-20 grid grid-cols-3 border-b border-(--bt-line) bg-(--bt-panel)">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={tab === t.id}
            // Only the selected tab's panel is rendered: an aria-controls to a missing id is invalid.
            aria-controls={tab === t.id ? `panel-${t.id}` : undefined}
            onClick={() => setTab(t.id)}
            className={cn("relative flex h-11 items-center justify-center gap-1.5 text-sm font-semibold", tab === t.id ? "text-(--bt-ink)" : "text-(--bt-muted)")}
          >
            <t.Icon className="size-4" aria-hidden="true" />
            {t.label}
            {t.id === "phone" && smsCount > 0 && tab !== "phone" ? (
              <>
                <span aria-hidden="true" className="absolute top-2 right-[28%] size-2 rounded-full bg-(--ai)" />
                <span className="sr-only">, new text</span>
              </>
            ) : null}
            {tab === t.id ? <span aria-hidden="true" className="absolute inset-x-6 bottom-0 h-0.5 rounded bg-(--ai)" /> : null}
          </button>
        ))}
      </div>
      <main className="flex-1 pb-24">
        {tab === "call" ? (
          <div role="tabpanel" id="panel-call" aria-labelledby="tab-call" className="space-y-3 p-3">
            <h2 className="sr-only">The call</h2>
            <CallTimeline />
            <div className="bt-panel p-3">
              <ControlColumn showDockedPhone={false} />
            </div>
            <div className="bt-panel h-[60dvh] min-h-[360px] overflow-hidden">
              <TranscriptLanes />
            </div>
          </div>
        ) : null}
        {tab === "case" ? (
          <div role="tabpanel" id="panel-case" aria-labelledby="tab-case" className="p-3">
            <div className="bt-panel overflow-hidden">
              <CaseCard />
            </div>
          </div>
        ) : null}
        {tab === "phone" ? (
          <div ref={phonePanel} role="tabpanel" id="panel-phone" aria-labelledby="tab-phone" className="p-4">
            <h2 className="sr-only">The customer&apos;s phone</h2>
            <DockedPhone />
          </div>
        ) : null}
      </main>
      {passVisible && !recorded ? (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-(--bt-line) bg-(--bt-panel)/95 p-3 backdrop-blur">
          <PassButton compact />
        </div>
      ) : null}
    </div>
  );
}

export function CallConsole() {
  const isMobile = !useMinWidth(768, true);
  const wide = useMinWidth(1600, false);
  const xl = useMinWidth(1280, true);
  return (
    <TooltipProvider delayDuration={150}>
      <div className={cn("bt-console flex min-h-dvh flex-col", !isMobile && "h-dvh")}>
        <TopBar />
        <NarratorStrip />
        <ProvenanceStrip />
        <Banners />
        {isMobile ? (
          <MobileConsole />
        ) : (
          <main className="relative flex min-h-0 flex-1 flex-col gap-3 p-3">
            <div
              className={cn(
                "grid min-h-0 flex-1 gap-3",
                xl ? "grid-cols-[minmax(0,38fr)_minmax(0,36fr)_minmax(0,26fr)]" : "grid-cols-[minmax(0,1fr)_minmax(320px,400px)]",
              )}
            >
              {xl ? (
                <>
                  <div className="bt-panel min-h-0 overflow-hidden">
                    <TranscriptLanes />
                  </div>
                  <div className="bt-panel min-h-0 overflow-hidden">
                    <CaseCard />
                  </div>
                  <aside aria-label="Controls" className="bt-panel bt-scroll min-h-0 p-4">
                    <ControlColumn showDockedPhone={wide} />
                  </aside>
                </>
              ) : (
                <>
                  <div className="bt-panel min-h-0 overflow-hidden">
                    <CaseCard />
                  </div>
                  <div className="flex min-h-0 min-w-0 flex-col gap-3">
                    <aside aria-label="Controls" className="bt-panel bt-scroll max-h-[55%] shrink-0 p-4">
                      <ControlColumn showDockedPhone={false} />
                    </aside>
                    <div className="bt-panel min-h-[220px] flex-1 overflow-hidden">
                      <TranscriptLanes />
                    </div>
                  </div>
                </>
              )}
            </div>
            <CallTimeline />
            <PreflightOverlay />
          </main>
        )}
        {isMobile ? (
          <div className="pointer-events-none fixed inset-0 z-30 [&>*]:pointer-events-auto">
            <MobilePreflight />
          </div>
        ) : null}
        {!isMobile && !wide ? <FloatingPhone /> : null}
        <PausedOverlay />
        <AudioLockedOverlay />
      </div>
    </TooltipProvider>
  );
}

function MobilePreflight() {
  const phase = useBaton((s) => s.phase);
  if (phase !== "preflight") return null;
  return (
    <div className="absolute inset-0 flex items-start justify-center overflow-y-auto bg-(--bt-bg)/70 p-3 pt-24 backdrop-blur-[3px]">
      <PreflightCard />
    </div>
  );
}

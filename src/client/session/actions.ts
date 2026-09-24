/**
 * client/session/actions.ts - what the console's buttons do. The page orchestrator implements it for real runs;
 * /dev/ui implements it over the fixture player. Components only ever call these.
 */
import "client-only";

import type { Evidence, FieldId } from "@/core/contracts/case";
import type { TranscriptLine } from "@/core/contracts/ext/wp7-ui";
import type { Suggestion } from "@/core/contracts/services";

export interface ConsoleActions {
  /** MUST run the audio unlock synchronously inside the click handler (AudioEngine.unlockSync, DESIGN §7.6). */
  start(kind: "express" | "full"): void;
  pass(): void;
  stopPlayback(): void;
  resume(): void;
  watchCachedNow(): void;
  retry(): void;
  watchReplay(): void;
  playEvidence(ev: Evidence, field: FieldId | null): Promise<void>;
  playTurn(line: TranscriptLine): Promise<void>;
  setAutopilot(on: boolean): void;
  playSuggestion(s: Suggestion): Promise<void>;
  sendTyped(text: string): Promise<void>;
  toggleMic(on: boolean): Promise<boolean>;
  askForDaniel(): void;
  endCall(): void;
  unlockAudio(): void;
}

const noop = () => {};
const noopAsync = async () => {};

export const NOOP_ACTIONS: ConsoleActions = {
  start: noop,
  pass: noop,
  stopPlayback: noop,
  resume: noop,
  watchCachedNow: noop,
  retry: noop,
  watchReplay: noop,
  playEvidence: noopAsync,
  playTurn: noopAsync,
  setAutopilot: noop,
  playSuggestion: noopAsync,
  sendTyped: noopAsync,
  toggleMic: async () => false,
  askForDaniel: noop,
  endCall: noop,
  unlockAudio: noop,
};

/**
 * src/content - typed public copy owned by WP13 (TASKS-v2 §4.1), rendered by WP7b on `/` and reused by the README,
 * the slides and the video. Pure data and pure helpers: safe to import from server and client components.
 */
export type {
  AboutContent,
  AboutSection,
  CtaTarget,
  Direction,
  FieldNote,
  GalleryBadge,
  GalleryCardCopy,
  Inline,
  LandingContent,
  LandingHero,
  NumberTag,
  PipelineStep,
  PitchNumber,
  RichText,
  StatusPillCopy,
} from "@/core/contracts/ext/wp13-content";

export { ABOUT, LLM_GATEWAY_LINE } from "./about";
export { FIELD_NOTES, FIELD_NOTES_INTRO, FIELD_NOTES_TITLE, ITERATION_LOG } from "./field-notes";
export { H1, LANDING } from "./landing";
export { PITCH_NUMBERS, pitchNumber, renderableNumbers, type PitchNumberId } from "./numbers";
export { inlineText, istTime, plainText, statusPillText, type PillStatus } from "./text";

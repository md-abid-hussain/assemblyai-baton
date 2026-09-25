/**
 * contracts/v2/index.ts - barrel for the v2 platform contracts (PLATFORM v2.1, TASKS-v2 §5). WP14a; frozen at C2.
 * Import from "@/core/contracts/v2". Not re-exported by the v1 barrel (contracts/index.ts), so v1 names such as
 * `TRANSCRIPTION_MODES` or `StageSchema` never collide with their v2 namesakes.
 */
export * from "./regex";
export * from "./blueprint";
export * from "./relay";
export * from "./api";
export type * from "./services";

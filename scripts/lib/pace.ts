/**
 * pace.ts - Node-side real-time pacing (DESIGN §3.2). WP0a made the pacer isomorphic in src/core/audio/pace.ts,
 * so this module simply re-exports it for scripts (import from here in scripts/**).
 */
export { pace, paceAudio, sleepMs, type PaceAudioOptions, type PaceOptions, type PacedChunk } from "../../src/core/audio/pace";

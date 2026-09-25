/**
 * All Baton AudioWorklet processors as ONE module source (one Blob URL, one `addModule`, DESIGN §7.6). Each
 * processor's source is wrapped in its own block so top-level names cannot collide.
 */
import { CALL_PLAYER_PROCESSOR, CALL_PLAYER_WORKLET_SOURCE } from "./call-player.worklet";
import { CLOCK_PROCESSOR, CLOCK_WORKLET_SOURCE } from "./clock.worklet";
import { MIC_CAPTURE_PROCESSOR, MIC_CAPTURE_WORKLET_SOURCE } from "./mic-capture.worklet";
import { VA_OUTPUT_PROCESSOR, VA_OUTPUT_WORKLET_SOURCE } from "./va-output.worklet";

export { CALL_PLAYER_PROCESSOR, CLOCK_PROCESSOR, MIC_CAPTURE_PROCESSOR, VA_OUTPUT_PROCESSOR };

export const ALL_WORKLETS_SOURCE = [CALL_PLAYER_WORKLET_SOURCE, VA_OUTPUT_WORKLET_SOURCE, CLOCK_WORKLET_SOURCE, MIC_CAPTURE_WORKLET_SOURCE]
  .map((s) => `{\n${s}\n}`)
  .join("\n");

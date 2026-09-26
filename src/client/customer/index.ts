/**
 * client/customer - WP11: the customer half of the AI half (DESIGN §5.15, PLATFORM §7.5 step 5).
 *
 * `createCustomerInput(deps)` is the `SessionControllers.createCustomerInput` seam the /call orchestrator already
 * calls (src/client/session/orchestrator.ts). See docs/notes/requests/wp11-to-wp7.md for the four dependencies the
 * page has to hand it.
 */
import "client-only";

export {
  createCustomerInput, CustomerInputController, LOCAL_CLIP_VOLUME,
  type CustomerAudioPort, type CustomerInputDeps, type CustomerInputExt, type CustomerStorePort, type CustomerVaPort,
} from "./customer-input";
export { AUTOPILOT_ARM_MS, AUTOPILOT_STALL_MS, planAutopilot, samePlan, type AutopilotPlan, type AutopilotReason, type AutopilotSnapshot } from "./autopilot";
export {
  chainClipIndexes, createChipIndex, createClipLoader, createSimClipIndex, loadChipManifest, simClipKey, EMPTY_CLIP_INDEX,
  type ChipIndex, type ClipIndex, type ClipLoader, type CustomerClipRef,
} from "./clips";
export {
  CHIP_HASH_RE, CHIP_MANIFEST_URL, ChipCallSchema, ChipClipSchema, ChipManifestSchema, chipClipUrl, normalizeChipText,
  EMPTY_CHIP_MANIFEST, type ChipCall, type ChipClip, type ChipManifest,
} from "./manifest";
export { buildSuggestions, kindForClass, MAX_SUGGESTIONS, type CustomerSuggestion, type SuggestionInput, type SuggestionSet } from "./suggestions";

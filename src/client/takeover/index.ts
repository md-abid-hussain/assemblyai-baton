import "client-only";

/** The takeover protocol client (WP5): controller, HTTP API and ports. The pure machine is src/core/protocol. */
export { createTakeoverController, TakeoverControllerImpl } from "./controller";
export { HttpTakeoverApi, type HttpTakeoverApiOptions } from "./api";
export {
  TakeoverApiError,
  type RecordedAiPlayer,
  type RequestOpts,
  type TakeoverApi,
  type TakeoverControllerDeps,
  type Timers,
  type VaSession,
  type VaSessionEvent,
} from "./ports";

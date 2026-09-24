/**
 * client/session/controllers.ts - THE G2 WIRING SEAM. The integrator replaces `getSessionControllers()` with the real
 * WP4 / WP5 / WP5b / WP11 factories (docs/notes/wp7.md "What the integrator must wire"). Until then /call runs the
 * pre-flight against the real routes and explains on Start that live playback is not wired into this build;
 * /dev/ui and /call/<id>?fixture=<name> render every state from fixture logs.
 *
 * Sketch of the G2 body (names from docs/notes/requests/wp4-to-wp7.md and wp5b.md §5):
 *   engine: () => getAudioEngine(),
 *   lifecycle: () => createPageLifecycle(),
 *   createCaseSync: (c) => new HttpCaseSync({ caseToken: c.create.caseToken, visitorToken: c.create.visitorToken, sink: c.sink, now: c.now, initialState: c.create.state }),
 *   createCachedReplay: (c) => new CachedReplay({ caseId: c.create.caseId, sink: c.sink, caseSync: c.caseSync, now: c.now, url: c.create.cachedTurnsUrl, takeover: c.takeoverState }),
 *   createStt: (c) => new LiveSttChannelManager({ api: new HttpSttApi({ caseToken, visitorToken }), sink: c.sink, caseSync: c.caseSync, cached: c.cached, now: c.now, takeover: c.takeoverState, strictBegin: process.env.NODE_ENV !== "production" }),
 *   createTakeover: (c) => new BrowserTakeoverController({ ...WP5 deps, playback: c.playback, stt: c.stt, caseSync: c.caseSync, plan: c.plan, sink: c.sink }),
 *   createCustomerInput: (c) => createCustomerInput({ ...WP11 deps }),
 *   askForRep / endCall: the WP5b VoiceAgentController of the current takeover,
 *   playAiClip: (ev, w) => playAudioElement(`/api/va-sessions/${vaSessionId}/audio#t=${w.fromMs / 1000},${w.toMs / 1000}`),
 */
import "client-only";

import type { SessionControllers } from "./orchestrator";

export function getSessionControllers(): SessionControllers | null {
  return null;
}

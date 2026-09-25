/**
 * src/content/text.ts - small pure helpers for rendering `src/content/**` copy. No React, no env, no Node: safe in
 * server and client components alike.
 */
import type { Inline, RichText, StatusPillCopy } from "@/core/contracts/ext/wp13-content";

/** Plain text of a rich-text run (for meta tags, aria labels and length checks). */
export function plainText(rich: RichText): string {
  return rich.map(inlineText).join("");
}

export function inlineText(part: Inline): string {
  if (typeof part === "string") return part;
  return "strong" in part ? part.strong : part.code;
}

/** "17:30" for an ISO instant, in IST (the status pill's zone, P§10.3). Null for a missing or invalid instant. */
export function istTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(d);
}

/** The minimal status the pill needs: `/api/status` `aiHalfAvailable`, plus v2's `nextLiveAt` when present. */
export interface PillStatus {
  aiHalfAvailable: boolean;
  nextLiveAt?: string | null;
}

/**
 * The status pill's text. `null` status = the API is down or has not answered (the landing still renders).
 * Replay without a known next window falls back to the plain replay wording.
 */
export function statusPillText(copy: StatusPillCopy, status: PillStatus | null): string {
  if (!status) return copy.unknown;
  if (status.aiHalfAvailable) return copy.live;
  const time = istTime(status.nextLiveAt);
  return time ? copy.replay.replace("{time}", time) : copy.replay.replace(/ · [^·]*\{time\}.*$/, "");
}

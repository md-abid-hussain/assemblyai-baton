import "client-only";

/**
 * "Dismissible per session" (SAAS §8.2's guest banner, §8.3's checklist). WP20.
 *
 * `sessionStorage`, not a cookie and not a DB row: the banner is a nudge, not a preference, and it should come
 * back in the next session because the workspace really is still unsaved. A guest who dismisses it and returns
 * tomorrow to an unclaimed workspace deserves to be told again.
 *
 * Every access is wrapped: `sessionStorage` throws in a sandboxed iframe and in Safari's private mode, and a
 * banner is never worth an exception that unmounts the shell.
 */

const PREFIX = "cx.dismissed.";

export function isDismissed(key: string): boolean {
  try {
    return globalThis.sessionStorage?.getItem(PREFIX + key) === "1";
  } catch {
    return false;
  }
}

export function dismiss(key: string): void {
  try {
    globalThis.sessionStorage?.setItem(PREFIX + key, "1");
  } catch {
    /* storage unavailable: the banner simply returns on the next render */
  }
}

export const DISMISS_GUEST_BANNER = "guest-banner";
export const DISMISS_CHECKLIST = "checklist";

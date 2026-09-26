import "server-only";

/**
 * Tiny pure helpers shared by the legacy Baton handlers (`src/server/tools/service.ts`) and the generic connector
 * built-ins (`builtins.ts`), so the two paths cannot drift. WP16·2.
 */

/** "END-48213" → "E N D 4 8 2 1 3". */
export const spokenChars = (s: string): string => s.replace(/[^A-Za-z0-9]/g, "").split("").join(" ");

/** The SMS link shown on the MockPhone (a page of ours, never the provider's URL). */
export function payLinkOf(origin: string, paymentId: string): string {
  const o = (() => {
    try {
      return new URL(origin).origin;
    } catch {
      return "";
    }
  })();
  return `${o}/pay/${paymentId}`;
}

/** "END-" + 5 digits (the default confirmation number generator on both paths). */
export const defaultConfirmationNumber = (): string => `END-${String(Math.floor(10000 + Math.random() * 90000))}`;

import "client-only";

/**
 * The Polar embedded checkout, as MockPhone uses it (DESIGN §5.12 "Client"):
 * - `success` is ALWAYS default-prevented (`@polar-sh/checkout@0.4.1` otherwise sets `window.location.href` to the
 *   success URL), then the page asks the server to reconcile; events never set a status themselves;
 * - the overlay is ours to close (`close()` on server success/failure, hold timeout, simulate, hand-back);
 * - a load guard: when Polar refuses to be framed (T-D1-9: the origin is not in the org's Settings → Preferences →
 *   Embedding list, so Polar answers `frame-ancestors 'none'`) the SDK's promise never resolves and its grey
 *   backdrop would trap the judge. After `loadTimeoutMs` we remove whatever the SDK injected and report failure; the
 *   phone then shows the hosted "Open checkout in a new tab" link and Simulate.
 */

export interface EmbedHandlers {
  onLoaded?: () => void;
  onConfirmed?: () => void;
  onSuccess?: () => void;
  onClose?: () => void;
}

export interface EmbedHandle {
  close(): void;
}

interface EmbedCheckoutLike {
  close(): void;
  addEventListener(type: string, listener: (e: CustomEvent) => void): void;
}

export const EMBED_LOAD_TIMEOUT_MS = 12_000;
/** After the iframe's `load` event, Polar's "loaded" message must follow within this long (a refused frame never sends it). */
export const EMBED_AFTER_LOAD_MS = 4_000;

export async function openPolarEmbed(url: string, h: EmbedHandlers, opts: { theme?: "light" | "dark"; loadTimeoutMs?: number } = {}): Promise<EmbedHandle> {
  const { PolarEmbedCheckout } = await import("@polar-sh/checkout/embed");
  const injected: Element[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let afterLoadTimer: ReturnType<typeof setTimeout> | undefined;
  let fail: (e: Error) => void = () => undefined;
  const timeout = new Promise<never>((_, reject) => {
    fail = reject;
    timer = setTimeout(() => reject(new Error("embed_load_timeout")), opts.loadTimeoutMs ?? EMBED_LOAD_TIMEOUT_MS);
  });
  const mo = new MutationObserver((recs) => {
    for (const r of recs)
      r.addedNodes.forEach((n) => {
        if (!(n instanceof Element)) return;
        injected.push(n);
        // A refused frame (frame-ancestors) still fires `load` (on an error page) but never posts "loaded": fail fast.
        const frame = n instanceof HTMLIFrameElement ? n : n.querySelector("iframe");
        frame?.addEventListener("load", () => {
          afterLoadTimer = setTimeout(() => fail(new Error("embed_refused")), EMBED_AFTER_LOAD_MS);
        });
      });
  });
  mo.observe(document.body, { childList: true });
  let co: EmbedCheckoutLike;
  try {
    co = (await Promise.race([
      PolarEmbedCheckout.create(url, { theme: opts.theme ?? "light", onLoaded: () => h.onLoaded?.() }),
      timeout,
    ])) as unknown as EmbedCheckoutLike;
  } catch (e) {
    for (const el of injected) el.remove();
    throw e;
  } finally {
    clearTimeout(timer);
    clearTimeout(afterLoadTimer);
    mo.disconnect();
  }
  co.addEventListener("success", (e) => {
    e.preventDefault(); // never navigate (the SDK would set window.location to the success URL)
    h.onSuccess?.();
  });
  co.addEventListener("confirmed", () => h.onConfirmed?.());
  co.addEventListener("close", () => h.onClose?.());
  let closed = false;
  return {
    close() {
      if (closed) return;
      closed = true;
      try {
        co.close();
      } catch {
        /* already gone */
      }
      for (const el of injected) if (el.isConnected) el.remove();
    },
  };
}

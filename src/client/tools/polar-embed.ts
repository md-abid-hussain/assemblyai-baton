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

export async function openPolarEmbed(url: string, h: EmbedHandlers, opts: { theme?: "light" | "dark"; loadTimeoutMs?: number } = {}): Promise<EmbedHandle> {
  const { PolarEmbedCheckout } = await import("@polar-sh/checkout/embed");
  const injected: Element[] = [];
  const mo = new MutationObserver((recs) => {
    for (const r of recs) r.addedNodes.forEach((n) => n instanceof Element && injected.push(n));
  });
  mo.observe(document.body, { childList: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("embed_load_timeout")), opts.loadTimeoutMs ?? EMBED_LOAD_TIMEOUT_MS);
  });
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

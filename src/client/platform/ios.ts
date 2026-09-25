/**
 * ios.ts - platform sniffing for the iOS-only rules of DESIGN §7.6 (silent switch, backgrounding). iPadOS 13+
 * reports itself as "Macintosh", so a touch-capable Mac is treated as iOS.
 */
import "client-only";

export interface NavigatorLike {
  userAgent: string;
  platform?: string;
  maxTouchPoints?: number;
}

export function detectIOS(nav: NavigatorLike | undefined = typeof navigator !== "undefined" ? navigator : undefined): boolean {
  if (!nav) return false;
  const ua = nav.userAgent || "";
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  // iPadOS desktop-class UA: "Macintosh" + touch.
  return /Macintosh/.test(ua) && (nav.maxTouchPoints ?? 0) > 1;
}

export function detectSafari(nav: NavigatorLike | undefined = typeof navigator !== "undefined" ? navigator : undefined): boolean {
  if (!nav) return false;
  const ua = nav.userAgent || "";
  return /Safari\//.test(ua) && !/Chrome\/|Chromium\/|CriOS\/|Edg\/|FxiOS\/|Firefox\//.test(ua);
}

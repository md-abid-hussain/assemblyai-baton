/**
 * `/app/settings` → Profile. WP20·2.
 *
 * §8.1's route map has no bare `/app/settings`, and the side nav points at `/app/settings/profile` directly —
 * but people type the parent path and old links point at it, and a 404 inside the shell reads as a broken
 * product. Profile is the one settings page every role can open, so it is the correct landing.
 */
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default function SettingsIndexPage(): never {
  redirect("/app/settings/profile");
}

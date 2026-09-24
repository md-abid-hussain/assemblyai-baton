import type { Metadata, Viewport } from "next";
import type * as React from "react";

import { Toaster } from "@/components/ui/sonner";

import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Baton", template: "%s · Baton" },
  description:
    "Baton: a human rep diagnoses the call, then passes the baton mid-call to an AssemblyAI Voice Agent that already knows the case.",
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-dvh">
        {children}
        <Toaster position="top-center" />
      </body>
    </html>
  );
}

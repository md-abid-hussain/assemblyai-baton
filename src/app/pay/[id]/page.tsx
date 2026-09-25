import type { Metadata } from "next";

export const metadata: Metadata = { title: "Secure link", robots: { index: false, follow: false } };

/**
 * `/pay/[id]`: the link in the MockPhone SMS. In Baton the customer's phone is simulated on the call page, so the
 * link is opened there (the phone's e-sign sheet). Opened anywhere else, this page says so.
 */
export default function PayLinkPage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-3 p-6 text-center">
      <h1 className="text-xl font-semibold">This secure link opens on the simulated phone</h1>
      <p className="text-sm text-muted-foreground">
        In the Baton demo the customer&apos;s phone is shown next to the call. Go back to the Baton tab and tap the link in the
        phone&apos;s messages to review, sign and pay (Polar sandbox, test card).
      </p>
    </main>
  );
}

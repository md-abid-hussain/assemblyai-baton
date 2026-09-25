import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { PhoneLab } from "@/components/phone/PhoneLab";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "MockPhone lab", robots: { index: false, follow: false } };

/** `/pay/lab` (DEV ONLY; 404 in production unless PAY_LAB=1): the MockPhone against a seeded payment. */
export default function PayLabPage() {
  if (process.env.NODE_ENV === "production" && process.env.PAY_LAB !== "1") notFound();
  return <PhoneLab />;
}

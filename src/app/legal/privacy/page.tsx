import type { Metadata } from "next";
import { LegalPage } from "@/views/proviso/reading";
export const metadata: Metadata = { title: "Privacy notice" };
export default function Page() {
  return <LegalPage kind="privacy" />;
}

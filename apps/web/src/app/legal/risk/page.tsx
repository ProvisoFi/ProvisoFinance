import type { Metadata } from "next";
import { LegalPage } from "@/views/proviso/reading";
export const metadata: Metadata = { title: "Risk disclosure" };
export default function Page() {
  return <LegalPage kind="risk" />;
}

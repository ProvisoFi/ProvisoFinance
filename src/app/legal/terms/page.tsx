import type { Metadata } from "next";
import { LegalPage } from "@/views/proviso/reading";
export const metadata: Metadata = { title: "Terms of use" };
export default function Page() {
  return <LegalPage kind="terms" />;
}

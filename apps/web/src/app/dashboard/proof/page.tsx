import type { Metadata } from "next";
import { Proof } from "@/views/workspace/records";
export const metadata: Metadata = { title: "Proof of Call" };
export default function Page() {
  return <Proof />;
}

import type { Metadata } from "next";
import { Records } from "@/views/workspace/records";
export const metadata: Metadata = { title: "Call ledger" };
export default function Page() {
  return <Records />;
}

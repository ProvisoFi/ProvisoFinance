import type { Metadata } from "next";
import { Replay } from "@/views/workspace/operations";
export const metadata: Metadata = { title: "Strategy tester" };
export default function Page() {
  return <Replay />;
}

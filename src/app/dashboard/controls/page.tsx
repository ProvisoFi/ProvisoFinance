import type { Metadata } from "next";
import { Controls } from "@/views/workspace/operations";
export const metadata: Metadata = { title: "Risk controls" };
export default function Page() {
  return <Controls />;
}

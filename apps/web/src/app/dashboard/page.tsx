import type { Metadata } from "next";
import { Overview } from "@/views/workspace/overview";
export const metadata: Metadata = { title: "Workspace overview" };
export default function Page() {
  return <Overview />;
}

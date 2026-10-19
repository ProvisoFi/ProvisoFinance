import type { Metadata } from "next";
import { FairCopyWorkspace } from "@/views/workspace/fair-copy";
export const metadata: Metadata = { title: "Fair Copy workspace" };
export default function Page() {
  return <FairCopyWorkspace />;
}

import type { Metadata } from "next";
import { Activity } from "@/views/workspace/operations";
export const metadata: Metadata = { title: "Workspace activity" };
export default function Page() {
  return <Activity />;
}

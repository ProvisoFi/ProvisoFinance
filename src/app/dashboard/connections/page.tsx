import type { Metadata } from "next";
import { Connections } from "@/views/workspace/operations";
export const metadata: Metadata = { title: "Accounts and routes" };
export default function Page() {
  return <Connections />;
}

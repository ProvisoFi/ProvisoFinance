import type { Metadata } from "next";
import { Composer } from "@/views/workspace/composer";
export const metadata: Metadata = { title: "Write a thesis" };
export default function Page() {
  return <Composer />;
}

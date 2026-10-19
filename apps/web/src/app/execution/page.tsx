import type { Metadata } from "next";
import { Execution } from "@/views/product/operations";
export const metadata: Metadata = { title: "Execution" };
export default function Page() {
  return <Execution />;
}

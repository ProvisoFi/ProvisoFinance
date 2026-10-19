import type { Metadata } from "next";
import { Protocol } from "@/views/product/protocol";
export const metadata: Metadata = { title: "The protocol" };
export default function Page() {
  return <Protocol />;
}

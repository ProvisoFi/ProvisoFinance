import type { Metadata } from "next";
import { CopyProduct } from "@/views/product/fair-copy";
export const metadata: Metadata = { title: "Fair Copy" };
export default function Page() {
  return <CopyProduct />;
}

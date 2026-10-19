import type { Metadata } from "next";
import { DocsHub } from "@/views/product/documentation";
export const metadata: Metadata = { title: "Documentation" };
export default function Page() {
  return <DocsHub />;
}

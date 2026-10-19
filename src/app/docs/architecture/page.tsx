import type { Metadata } from "next";
import { Architecture } from "@/views/product/documentation";
export const metadata: Metadata = { title: "Architecture" };
export default function Page() {
  return <Architecture />;
}

import type { Metadata } from "next";
import { Testing } from "@/views/product/operations";
export const metadata: Metadata = { title: "Strategy testing" };
export default function Page() {
  return <Testing />;
}

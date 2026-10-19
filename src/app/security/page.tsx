import type { Metadata } from "next";
import { Security } from "@/views/product/operations";
export const metadata: Metadata = { title: "Self-custody" };
export default function Page() {
  return <Security />;
}

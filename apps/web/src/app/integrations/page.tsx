import type { Metadata } from "next";
import { Integrations } from "@/views/product/ecosystem";
export const metadata: Metadata = { title: "Integrations" };
export default function Page() {
  return <Integrations />;
}

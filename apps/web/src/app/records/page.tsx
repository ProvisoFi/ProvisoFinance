import type { Metadata } from "next";
import { RecordProduct } from "@/views/product/record";
export const metadata: Metadata = {
  title: "The record",
  description:
    "Every call, in context. Explore commitments, disclosures, outcomes, and integrity signals.",
};
export default function Page() {
  return <RecordProduct />;
}

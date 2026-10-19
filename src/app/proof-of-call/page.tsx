import type { Metadata } from "next";
import { ProofProduct } from "@/views/product/proof";
export const metadata: Metadata = { title: "Proof of Call" };
export default function Page() {
  return <ProofProduct />;
}

import type { Metadata } from "next";
import { DryRun } from "@/views/workspace/dry-run";
export const metadata: Metadata = {
  title: "Dry Run",
  description: "Try a trading rule on 90 days of real Hyperliquid history and on live prices. No wallet, no deposit.",
};
export default function Page() {
  return <DryRun />;
}

import type { MetadataRoute } from "next";
export const dynamic = "force-static";
export default function sitemap(): MetadataRoute.Sitemap {
  const base = (
    process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000"
  ).replace(/\/$/, "");
  return [
    "/",
    "/dashboard/",
    "/dashboard/activity/",
    "/dashboard/compose/",
    "/dashboard/connections/",
    "/dashboard/controls/",
    "/dashboard/fair-copy/",
    "/dashboard/proof/",
    "/dashboard/records/",
    "/dashboard/replay/",
    "/docs/",
    "/docs/architecture/",
    "/records/",
    "/leaderboard/",
    "/execution/",
    "/fair-copy/",
    "/integrations/",
    "/legal/privacy/",
    "/legal/risk/",
    "/legal/terms/",
    "/proof-of-call/",
    "/protocol/",
    "/security/",
    "/testing/",
  ].map((path) => ({ url: base + path }));
}

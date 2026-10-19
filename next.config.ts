import type { NextConfig } from "next";
const config: NextConfig = { output: "export", turbopack: { root: process.cwd() }, trailingSlash: true, poweredByHeader: false, images: { unoptimized: true } };
export default config;

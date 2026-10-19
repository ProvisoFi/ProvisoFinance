import path from "node:path";
import type { NextConfig } from "next";

const root = path.join(__dirname, "../..");

const config: NextConfig = {
  turbopack: { root },
  outputFileTracingRoot: root,
  transpilePackages: ["@proviso/api", "@proviso/db", "@proviso/dsl"],
  trailingSlash: true,
  poweredByHeader: false,
  images: { unoptimized: true },
};
export default config;

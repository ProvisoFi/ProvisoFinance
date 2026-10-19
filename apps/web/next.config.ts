import path from "node:path";
import type { NextConfig } from "next";

const root = path.join(__dirname, "../..");

const config: NextConfig = {
  turbopack: { root },
  outputFileTracingRoot: root,
  transpilePackages: ["@proviso/api", "@proviso/chain", "@proviso/db", "@proviso/dsl", "@proviso/hl", "@proviso/ops", "@proviso/seal"],
  trailingSlash: true,
  poweredByHeader: false,
  images: { unoptimized: true },
};
export default config;

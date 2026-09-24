import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // browser preview proxies reach the dev server via 127.0.0.1
  allowedDevOrigins: ["127.0.0.1"],
};

export default nextConfig;

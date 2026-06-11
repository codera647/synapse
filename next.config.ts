import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
};

export default nextConfig;

// Enables the Cloudflare bindings (env, etc.) during local `next dev` so the
// app behaves the same locally as it will on Cloudflare Workers. No-op outside dev.
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
initOpenNextCloudflareForDev();

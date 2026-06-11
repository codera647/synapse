// OpenNext configuration for deploying the Synapse Next.js app to Cloudflare Workers.
// Docs: https://opennext.js.org/cloudflare
import { defineCloudflareConfig } from "@opennextjs/cloudflare";

export default defineCloudflareConfig({
    // Default config works out of the box. To enable Incremental Static
    // Regeneration / cache, add an incrementalCache adapter here later
    // (e.g. R2 or KV) — not required for Synapse's mostly-dynamic app.
});

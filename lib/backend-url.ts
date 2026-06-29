// Resolves the backend base URL at request time.
//
// Priority:
//   1. The live tunnel URL written to KV (`TUNNELS` namespace, key `synapse_backend`)
//      by the VM on every boot/reconnect — so the URL is always current with zero
//      redeploys.
//   2. Static env vars (BACKEND_API_URL etc.) as a safe fallback if KV is empty
//      or the binding is missing.
//
// Server-side only (uses the Cloudflare context / process.env).
import { getCloudflareContext } from "@opennextjs/cloudflare";

function fromEnv(): string {
    return (
        process.env.RUNPOD_API_URL ||
        process.env.BACKEND_API_URL ||
        process.env.NEXT_PUBLIC_BACKEND_API_URL ||
        process.env.NEXT_PUBLIC_RUNPOD_API_URL ||
        ""
    ).trim().replace(/\/+$/, "");
}

export async function getBackendBaseUrl(): Promise<string> {
    try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const env = getCloudflareContext().env as any;
        const fromKv: string | null | undefined = await env?.TUNNELS?.get("synapse_backend");
        if (fromKv && fromKv.trim()) {
            return fromKv.trim().replace(/\/+$/, "");
        }
    } catch {
        // getCloudflareContext unavailable (e.g. local node) or KV read failed -> fall back
    }
    return fromEnv();
}

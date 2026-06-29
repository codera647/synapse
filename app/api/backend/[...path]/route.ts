import { NextRequest, NextResponse } from "next/server";
import { getBackendBaseUrl } from "@/lib/backend-url";

async function buildTargetUrl(path: string[] = [], search = "") {
    const base = await getBackendBaseUrl();
    if (!base) return null;
    const cleanPath = path.map((part) => encodeURIComponent(part)).join("/");
    const url = cleanPath ? `${base}/${cleanPath}` : base;
    return search ? `${url}${search}` : url;
}

async function proxy(request: NextRequest, method: "GET" | "POST", path: string[]) {
    const target = await buildTargetUrl(path, request.nextUrl.search);
    if (!target) {
        return NextResponse.json(
            {
                error: "Missing backend URL. Set BACKEND_API_URL or RUNPOD_API_URL.",
                hint: "This route proxies /api/backend/* to your GPU/Colab/RunPod backend.",
            },
            { status: 500 }
        );
    }

    const headers = new Headers();
    const contentType = request.headers.get("content-type");
    if (contentType) headers.set("content-type", contentType);

    const accept = request.headers.get("accept");
    if (accept) headers.set("accept", accept);

    const authorization = request.headers.get("authorization");
    if (authorization) headers.set("authorization", authorization);

    const apiKey = request.headers.get("x-api-key");
    if (apiKey) headers.set("x-api-key", apiKey);

    // Strongly discourage any intermediary caching (tunnels/proxies can be “creative”).
    headers.set("cache-control", "no-store, no-cache, max-age=0");
    headers.set("pragma", "no-cache");

    const init: RequestInit = {
        method,
        headers,
        cache: "no-store",
    };

    if (method === "POST") {
        init.body = await request.text();
    }

    // Chat/compact can legitimately take a while (multi-agent reasoning + long answers); other
    // endpoints should be snappy. The chat budget is env-tunable via BACKEND_CHAT_TIMEOUT_MS.
    const joined = (path ?? []).join("/").toLowerCase();
    const isLongRunning = joined === "chat" || joined === "chat/compact" || joined === "agent/run";
    const timeoutMs = isLongRunning ? Number(process.env.BACKEND_CHAT_TIMEOUT_MS || 240000) : 10000;

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        const response = await fetch(target, { ...init, signal: controller.signal });
        clearTimeout(timeout);
        const text = await response.text();

        const upstreamContentType = response.headers.get("content-type") || "";

        if (response.ok) {
            return new NextResponse(text, {
                status: response.status,
                headers: {
                    "content-type": upstreamContentType || "application/json",
                    "cache-control": "no-store, no-cache, max-age=0",
                    "pragma": "no-cache",
                },
            });
        }

        let upstreamJson: unknown | null = null;
        if (
            upstreamContentType.includes("application/json") ||
            text.trim().startsWith("{") ||
            text.trim().startsWith("[")
        ) {
            try {
                upstreamJson = JSON.parse(text);
            } catch {
                upstreamJson = null;
            }
        }

        return NextResponse.json(
            {
                error: `Backend responded with ${response.status}${response.statusText ? ` ${response.statusText}` : ""
                    }.`,
                upstream_status: response.status,
                upstream_content_type: upstreamContentType || null,
                upstream_body: upstreamJson,
                upstream_body_excerpt: text ? text.slice(0, 800) : "",
                target,
            },
            {
                status: response.status,
                headers: {
                    "cache-control": "no-store, no-cache, max-age=0",
                    "pragma": "no-cache",
                },
            }
        );
    } catch (error) {
        const isTimeout = error instanceof Error && error.name === "AbortError";
        return NextResponse.json(
            {
                error: isTimeout
                    ? `Backend request timed out after ${Math.round(timeoutMs / 1000)}s.`
                    : "Unable to reach the backend. Make sure it's running and BACKEND_API_URL is correct.",
                details: error instanceof Error ? error.message : "Unknown error",
                target,
            },
            { status: 502 }
        );
    }
}

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ path?: string[] }> }
) {
    const resolved = await params;
    return proxy(request, "GET", resolved.path ?? []);
}

export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ path?: string[] }> }
) {
    const resolved = await params;
    return proxy(request, "POST", resolved.path ?? []);
}

import { NextRequest, NextResponse } from "next/server";
import { getBackendBaseUrl } from "@/lib/backend-url";

// Binary proxy for inline answer visuals (figure/table PNGs from R2). Same rationale as /api/pdf:
// the generic text proxy would corrupt image bytes, so we stream them through here and keep
// BACKEND_API_URL server-side.

export async function GET(request: NextRequest) {
    const base = await getBackendBaseUrl();
    if (!base) {
        return NextResponse.json({ error: "Backend URL not configured." }, { status: 500 });
    }

    const key = request.nextUrl.searchParams.get("key");
    if (!key || !key.startsWith("visuals/")) {
        return NextResponse.json({ error: "A valid visuals/ key is required." }, { status: 400 });
    }

    const target = `${base}/visual/file?key=${encodeURIComponent(key)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
        const res = await fetch(target, { cache: "no-store", signal: controller.signal });
        clearTimeout(timeout);
        if (!res.ok || !res.body) {
            const text = await res.text().catch(() => "");
            return NextResponse.json(
                { error: `Backend responded with ${res.status}.`, body: text.slice(0, 300) },
                { status: res.status || 502 },
            );
        }
        return new NextResponse(res.body, {
            status: 200,
            headers: {
                "content-type": res.headers.get("content-type") || "image/png",
                "cache-control": "private, max-age=600",
            },
        });
    } catch (error) {
        clearTimeout(timeout);
        const isTimeout = error instanceof Error && error.name === "AbortError";
        return NextResponse.json(
            {
                error: isTimeout ? "Visual request timed out." : "Unable to fetch visual from backend.",
                details: error instanceof Error ? error.message : "unknown",
            },
            { status: 502 },
        );
    }
}

import { NextRequest, NextResponse } from "next/server";

// Binary/JSON proxy for Agent-mode artifacts (rendered chart PNGs + Vega-Lite spec JSON from R2).
// The generic text proxy would corrupt PNG bytes, so artifacts stream through here. Keeps
// BACKEND_API_URL server-side. Only `agents/` keys are allowed (enforced again on the backend).

function backendBase() {
    return (
        process.env.BACKEND_API_URL ||
        process.env.RUNPOD_API_URL ||
        process.env.NEXT_PUBLIC_BACKEND_API_URL ||
        process.env.NEXT_PUBLIC_RUNPOD_API_URL ||
        ""
    )
        .trim()
        .replace(/\/+$/, "");
}

export async function GET(request: NextRequest) {
    const base = backendBase();
    if (!base) {
        return NextResponse.json({ error: "Backend URL not configured." }, { status: 500 });
    }

    const key = request.nextUrl.searchParams.get("key");
    if (!key || !key.startsWith("agents/")) {
        return NextResponse.json({ error: "A valid agents/ key is required." }, { status: 400 });
    }

    const target = `${base}/agent/artifact/file?key=${encodeURIComponent(key)}`;
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
                "content-type": res.headers.get("content-type") || "application/octet-stream",
                "cache-control": "private, max-age=600",
            },
        });
    } catch (error) {
        clearTimeout(timeout);
        const isTimeout = error instanceof Error && error.name === "AbortError";
        return NextResponse.json(
            {
                error: isTimeout ? "Artifact request timed out." : "Unable to fetch artifact from backend.",
                details: error instanceof Error ? error.message : "unknown",
            },
            { status: 502 },
        );
    }
}

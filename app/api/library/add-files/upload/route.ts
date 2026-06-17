import { NextRequest, NextResponse } from "next/server";

// Multipart proxy for adding LOCAL files to an existing library. The generic /api/backend text proxy
// reads the body as text (corrupts binary multipart), so uploads stream their FormData through here to
// the backend's POST /library/add-files/upload (which writes to R2 + creates documents).

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

export async function POST(request: NextRequest) {
    const base = backendBase();
    if (!base) {
        return NextResponse.json({ error: "Backend URL not configured." }, { status: 500 });
    }
    const target = `${base}/library/add-files/upload`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);
    try {
        const form = await request.formData();
        const res = await fetch(target, {
            method: "POST",
            body: form,
            cache: "no-store",
            signal: controller.signal,
        });
        clearTimeout(timeout);
        const text = await res.text();
        return new NextResponse(text, {
            status: res.status,
            headers: { "content-type": res.headers.get("content-type") || "application/json" },
        });
    } catch (error) {
        clearTimeout(timeout);
        const isTimeout = error instanceof Error && error.name === "AbortError";
        return NextResponse.json(
            {
                error: isTimeout ? "Upload timed out." : "Unable to upload to backend.",
                details: error instanceof Error ? error.message : "unknown",
            },
            { status: 502 },
        );
    }
}

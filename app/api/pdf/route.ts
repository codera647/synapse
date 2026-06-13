import { NextRequest, NextResponse } from "next/server";

// Dedicated BINARY proxy for source PDFs. The generic /api/backend/[...path] proxy reads bodies
// as text (fine for JSON), which would corrupt PDF bytes — so the in-app PDF viewer fetches here
// instead. Keeps BACKEND_API_URL server-side and streams the file through unchanged.

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

    const docId = request.nextUrl.searchParams.get("doc_id");
    const orgId = request.nextUrl.searchParams.get("organization_id") || "";
    if (!docId) {
        return NextResponse.json({ error: "doc_id is required." }, { status: 400 });
    }

    const target =
        `${base}/document/file?doc_id=${encodeURIComponent(docId)}` +
        (orgId ? `&organization_id=${encodeURIComponent(orgId)}` : "");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);
    try {
        const res = await fetch(target, { cache: "no-store", signal: controller.signal });
        clearTimeout(timeout);

        if (!res.ok || !res.body) {
            const text = await res.text().catch(() => "");
            return NextResponse.json(
                { error: `Backend responded with ${res.status}.`, body: text.slice(0, 500) },
                { status: res.status || 502 },
            );
        }

        return new NextResponse(res.body, {
            status: 200,
            headers: {
                "content-type": "application/pdf",
                "cache-control": "private, max-age=300",
            },
        });
    } catch (error) {
        clearTimeout(timeout);
        const isTimeout = error instanceof Error && error.name === "AbortError";
        return NextResponse.json(
            {
                error: isTimeout ? "PDF request timed out." : "Unable to fetch PDF from backend.",
                details: error instanceof Error ? error.message : "unknown",
            },
            { status: 502 },
        );
    }
}

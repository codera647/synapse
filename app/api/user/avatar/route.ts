import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabaseAdmin";

// POST /api/user/avatar   (Authorization: Bearer <access_token>, multipart/form-data with `file`)
// Uploads a profile image with the service role. Self-healing: creates the public `avatars`
// bucket if it doesn't exist, so no manual Supabase Storage setup is required. Returns the
// public URL; the caller saves it via /api/user/preferences.

const EXT_BY_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

export async function POST(req: Request) {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Missing access token." }, { status: 401 });
  }
  const admin = createSupabaseAdminClient();
  const {
    data: { user },
    error: authError,
  } = await admin.auth.getUser(auth.slice("Bearer ".length).trim());
  if (authError || !user) {
    return NextResponse.json({ error: "Invalid or expired session." }, { status: 401 });
  }

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No image file provided." }, { status: 400 });
  }
  if (!file.type.startsWith("image/")) {
    return NextResponse.json({ error: "File must be an image." }, { status: 400 });
  }
  if (file.size > 2 * 1024 * 1024) {
    return NextResponse.json({ error: "Image must be 2 MB or smaller." }, { status: 400 });
  }

  // Ensure the bucket exists (ignore "already exists").
  const { error: bucketErr } = await admin.storage.createBucket("avatars", {
    public: true,
    fileSizeLimit: "2MB",
  });
  if (bucketErr && !String(bucketErr.message || "").toLowerCase().includes("exist")) {
    console.error("create avatars bucket error:", bucketErr);
    return NextResponse.json({ error: "Couldn't prepare avatar storage." }, { status: 500 });
  }

  const ext = EXT_BY_TYPE[file.type] || "png";
  const path = `${user.id}/avatar.${ext}`;
  const bytes = await file.arrayBuffer();

  const { error: upErr } = await admin.storage.from("avatars").upload(path, bytes, {
    upsert: true,
    contentType: file.type,
    cacheControl: "3600",
  });
  if (upErr) {
    console.error("avatar upload error:", upErr);
    return NextResponse.json({ error: "Upload failed." }, { status: 500 });
  }

  const { data: pub } = admin.storage.from("avatars").getPublicUrl(path);
  return NextResponse.json({ ok: true, url: `${pub.publicUrl}?v=${Date.now()}` });
}

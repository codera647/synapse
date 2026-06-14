"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { FiX, FiUser, FiUploadCloud, FiTrash2, FiLogOut, FiCheck, FiSliders, FiUserCheck } from "react-icons/fi";

// Shared shape — also consumed by the dashboard + chat to personalize answers.
export type Personalization = {
  nickname?: string | null;
  occupation?: string | null;
  about_me?: string | null;
  base_tone?: string; // default | professional | friendly | concise
  char_warmth?: string; // default | more | less
  char_enthusiasm?: string;
  char_headers_lists?: string;
  char_emoji?: string;
};

const DEFAULT_PREFS: Personalization = {
  nickname: "",
  occupation: "",
  about_me: "",
  base_tone: "default",
  char_warmth: "default",
  char_enthusiasm: "default",
  char_headers_lists: "default",
  char_emoji: "default",
};

const TONES = [
  { value: "default", label: "Default" },
  { value: "professional", label: "Professional" },
  { value: "friendly", label: "Friendly" },
  { value: "concise", label: "Concise" },
];

const CHARACTERISTICS: { key: keyof Personalization; label: string; hint: string }[] = [
  { key: "char_warmth", label: "Warmth", hint: "How warm and personable the tone feels" },
  { key: "char_enthusiasm", label: "Enthusiasm", hint: "Energy and excitement in replies" },
  { key: "char_headers_lists", label: "Headers & Lists", hint: "Structure answers with headings and bullets" },
  { key: "char_emoji", label: "Emoji", hint: "Use of emoji in responses" },
];

const LEVELS = [
  { value: "less", label: "Less" },
  { value: "default", label: "Default" },
  { value: "more", label: "More" },
];

type Tab = "profile" | "personalization" | "account";

export default function SettingsModal({
  supabase,
  open,
  onClose,
  onSaved,
  onLogout,
}: {
  supabase: SupabaseClient;
  open: boolean;
  onClose: () => void;
  onSaved?: (prefs: Personalization, profile: { name: string | null; avatarUrl: string | null }) => void;
  onLogout?: () => void;
}) {
  const [tab, setTab] = useState<Tab>("profile");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const [userId, setUserId] = useState<string | null>(null);
  const [email, setEmail] = useState<string>("");
  const [name, setName] = useState<string>("");
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<Personalization>(DEFAULT_PREFS);

  const fileRef = useRef<HTMLInputElement | null>(null);

  const flash = (kind: "ok" | "err", text: string) => {
    setNotice({ kind, text });
    window.setTimeout(() => setNotice((n) => (n?.text === text ? null : n)), 3500);
  };

  // Load identity + preferences whenever the modal opens.
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) return;

      const res = await fetch("/api/user/preferences", {
        headers: { authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (!res.ok) throw new Error("load-failed");
      const d = (await res.json()) as {
        user_id?: string;
        email?: string | null;
        name?: string | null;
        avatar_url?: string | null;
        prefs?: Record<string, unknown> | null;
      };
      const pref = d.prefs || {};
      setUserId(d.user_id ?? session?.user?.id ?? null);
      setEmail(d.email ?? session?.user?.email ?? "");
      setName(String(d.name || session?.user?.user_metadata?.full_name || ""));
      setAvatarUrl(d.avatar_url ?? null);
      setPrefs({
        nickname: (pref.nickname as string) ?? "",
        occupation: (pref.occupation as string) ?? "",
        about_me: (pref.about_me as string) ?? "",
        base_tone: (pref.base_tone as string) ?? "default",
        char_warmth: (pref.char_warmth as string) ?? "default",
        char_enthusiasm: (pref.char_enthusiasm as string) ?? "default",
        char_headers_lists: (pref.char_headers_lists as string) ?? "default",
        char_emoji: (pref.char_emoji as string) ?? "default",
      });
    } catch {
      flash("err", "Couldn't load your settings.");
    } finally {
      setLoading(false);
    }
  }, [supabase]);

  useEffect(() => {
    if (open) {
      setTab("profile");
      setNotice(null);
      void load();
    }
  }, [open, load]);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const pickFile = () => fileRef.current?.click();

  const onAvatarFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    if (!file || !userId) return;
    if (!file.type.startsWith("image/")) {
      flash("err", "Please choose an image file.");
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      flash("err", "Image must be 2 MB or smaller.");
      return;
    }
    setUploading(true);
    try {
      // Upload via the server (service role) — self-heals the bucket, no Storage setup needed.
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) throw new Error("no-session");

      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/user/avatar", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: fd,
      });
      const j = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!res.ok || !j.url) throw new Error(j.error || "upload-failed");
      setAvatarUrl(j.url);
      flash("ok", "Avatar uploaded — remember to Save.");
    } catch {
      flash("err", "Upload failed. Please try again.");
    } finally {
      setUploading(false);
    }
  };

  const removeAvatar = () => setAvatarUrl(null);

  const save = async () => {
    if (!userId) return;
    setSaving(true);
    try {
      const cleanName = name.trim() || null;
      const cleanAvatar = avatarUrl ? avatarUrl.split("?")[0] : null; // store canonical URL
      const prefsRow: Personalization = {
        nickname: (prefs.nickname || "").trim() || null,
        occupation: (prefs.occupation || "").trim() || null,
        about_me: (prefs.about_me || "").trim() || null,
        base_tone: prefs.base_tone || "default",
        char_warmth: prefs.char_warmth || "default",
        char_enthusiasm: prefs.char_enthusiasm || "default",
        char_headers_lists: prefs.char_headers_lists || "default",
        char_emoji: prefs.char_emoji || "default",
      };

      // Save via a server route (service role) so the write never trips browser RLS for these tables.
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) throw new Error("no-session");

      const res = await fetch("/api/user/preferences", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: cleanName, avatar_url: cleanAvatar, prefs: prefsRow }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || "save-failed");
      }

      onSaved?.(prefsRow, { name: cleanName, avatarUrl: cleanAvatar });
      flash("ok", "Settings saved.");
    } catch {
      flash("err", "Couldn't save your settings.");
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  const navItems: { key: Tab; label: string; icon: typeof FiUser }[] = [
    { key: "profile", label: "Profile", icon: FiUser },
    { key: "personalization", label: "Personalization", icon: FiSliders },
    { key: "account", label: "Account", icon: FiUserCheck },
  ];

  return (
    <div className="fixed inset-0 z-[80] grid place-items-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 flex h-[600px] max-h-[90vh] w-[min(880px,calc(100vw-32px))] overflow-hidden rounded-2xl surface-menu shadow-2xl shadow-black/50">
        {/* Left nav */}
        <aside className="hidden w-52 shrink-0 flex-col border-r border-white/10 bg-white/[0.02] p-3 sm:flex">
          <div className="px-2 pb-3 pt-1 text-sm font-semibold text-white/90">Settings</div>
          {navItems.map((n) => (
            <button
              key={n.key}
              type="button"
              onClick={() => setTab(n.key)}
              className={`mb-1 flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${
                tab === n.key ? "bg-white/8 text-white" : "text-white/60 hover:bg-white/6 hover:text-white"
              }`}
            >
              <n.icon className="h-4 w-4" />
              {n.label}
            </button>
          ))}
        </aside>

        {/* Main */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center justify-between border-b border-white/10 px-5 py-3.5">
            <h2 className="text-base font-semibold capitalize text-white/90">{tab}</h2>
            <button
              type="button"
              onClick={onClose}
              className="grid h-8 w-8 place-items-center rounded-lg text-white/50 hover:bg-white/8 hover:text-white"
            >
              <FiX className="h-4.5 w-4.5" />
            </button>
          </div>

          {/* Mobile tabs */}
          <div className="flex gap-1 border-b border-white/10 px-3 py-2 sm:hidden">
            {navItems.map((n) => (
              <button
                key={n.key}
                type="button"
                onClick={() => setTab(n.key)}
                className={`rounded-lg px-3 py-1.5 text-xs ${tab === n.key ? "bg-white/8 text-white" : "text-white/55"}`}
              >
                {n.label}
              </button>
            ))}
          </div>

          <div className="min-h-0 flex-1 overflow-auto synapse-scroll px-5 py-5">
            {loading ? (
              <div className="grid h-full place-items-center text-sm text-white/40">Loading…</div>
            ) : tab === "profile" ? (
              <div className="space-y-6">
                {/* Avatar */}
                <div className="flex items-center gap-4">
                  <div className="grid h-20 w-20 shrink-0 place-items-center overflow-hidden rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-500 ring-1 ring-white/20">
                    {avatarUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={avatarUrl} alt="Avatar" className="h-full w-full object-cover" />
                    ) : (
                      <FiUser className="h-8 w-8 text-white" />
                    )}
                  </div>
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={pickFile}
                        disabled={uploading}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-white/12 bg-white/5 px-3 py-1.5 text-xs font-medium text-white/80 hover:bg-white/8 disabled:opacity-60"
                      >
                        {uploading ? (
                          <span className="h-3.5 w-3.5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                        ) : (
                          <FiUploadCloud className="h-3.5 w-3.5" />
                        )}
                        {uploading ? "Uploading…" : "Upload"}
                      </button>
                      {avatarUrl ? (
                        <button
                          type="button"
                          onClick={removeAvatar}
                          className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs text-rose-300/90 hover:bg-rose-500/10"
                        >
                          <FiTrash2 className="h-3.5 w-3.5" /> Remove
                        </button>
                      ) : null}
                    </div>
                    <p className="text-[11px] text-white/40">JPG, PNG or GIF · up to 2 MB</p>
                  </div>
                  <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onAvatarFile} />
                </div>

                <Field label="Display name">
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Your name"
                    className="settings-input"
                  />
                </Field>

                <Field label="Nickname" hint="What Synapse should call you">
                  <input
                    value={prefs.nickname ?? ""}
                    onChange={(e) => setPrefs((p) => ({ ...p, nickname: e.target.value }))}
                    placeholder="e.g. Cipher"
                    className="settings-input"
                  />
                </Field>

                <Field label="Occupation">
                  <input
                    value={prefs.occupation ?? ""}
                    onChange={(e) => setPrefs((p) => ({ ...p, occupation: e.target.value }))}
                    placeholder="e.g. AI / Robotics Engineer"
                    className="settings-input"
                  />
                </Field>

                <Field label="More about you" hint="Context Synapse can use to tailor answers">
                  <textarea
                    value={prefs.about_me ?? ""}
                    onChange={(e) => setPrefs((p) => ({ ...p, about_me: e.target.value }))}
                    placeholder="Interests, goals, the kind of help you want…"
                    rows={4}
                    className="settings-input resize-none"
                  />
                </Field>

                <Field label="Email">
                  <input value={email} disabled className="settings-input opacity-60" />
                </Field>
              </div>
            ) : tab === "personalization" ? (
              <div className="space-y-6">
                <p className="text-xs text-white/45">
                  These shape <span className="text-white/70">how</span> Synapse writes — never its facts or citations.
                </p>

                <Field label="Base tone">
                  <div className="flex flex-wrap gap-2">
                    {TONES.map((t) => (
                      <button
                        key={t.value}
                        type="button"
                        onClick={() => setPrefs((p) => ({ ...p, base_tone: t.value }))}
                        className={`rounded-lg px-3 py-1.5 text-sm transition-colors ${
                          (prefs.base_tone || "default") === t.value
                            ? "bg-violet-500/20 text-white ring-1 ring-violet-400/40"
                            : "bg-white/5 text-white/60 hover:bg-white/8"
                        }`}
                      >
                        {t.label}
                      </button>
                    ))}
                  </div>
                </Field>

                <div className="space-y-4">
                  <div className="text-xs uppercase tracking-wide text-white/35">Characteristics</div>
                  {CHARACTERISTICS.map((c) => (
                    <div key={c.key} className="flex items-center justify-between gap-4">
                      <div className="min-w-0">
                        <div className="text-sm text-white/85">{c.label}</div>
                        <div className="text-[11px] text-white/40">{c.hint}</div>
                      </div>
                      <Segmented
                        value={(prefs[c.key] as string) || "default"}
                        onChange={(v) => setPrefs((p) => ({ ...p, [c.key]: v }))}
                      />
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="space-y-5">
                <Field label="Signed in as">
                  <input value={email} disabled className="settings-input opacity-60" />
                </Field>
                <div>
                  <button
                    type="button"
                    onClick={() => onLogout?.()}
                    className="inline-flex items-center gap-2 rounded-lg border border-rose-400/25 bg-rose-500/10 px-3.5 py-2 text-sm text-rose-200 hover:bg-rose-500/15"
                  >
                    <FiLogOut className="h-4 w-4" /> Log out
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between gap-3 border-t border-white/10 px-5 py-3.5">
            <div className="min-w-0 text-xs">
              {notice ? (
                <span className={notice.kind === "ok" ? "text-emerald-300" : "text-rose-300"}>{notice.text}</span>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg px-3.5 py-2 text-sm text-white/60 hover:bg-white/6 hover:text-white"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={save}
                disabled={saving || loading}
                className="btn-grad inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
              >
                {saving ? (
                  <span className="h-3.5 w-3.5 rounded-full border-2 border-white/40 border-t-white animate-spin" />
                ) : (
                  <FiCheck className="h-4 w-4" />
                )}
                {saving ? "Saving…" : "Save changes"}
              </button>
            </div>
          </div>
        </div>
      </div>

      <style jsx global>{`
        .settings-input {
          width: 100%;
          border-radius: 0.625rem;
          border: 1px solid rgba(255, 255, 255, 0.1);
          background: rgba(255, 255, 255, 0.04);
          padding: 0.55rem 0.75rem;
          font-size: 0.875rem;
          color: rgba(255, 255, 255, 0.92);
          outline: none;
          transition: border-color 0.15s ease;
        }
        .settings-input::placeholder {
          color: rgba(255, 255, 255, 0.35);
        }
        .settings-input:focus {
          border-color: rgba(167, 139, 250, 0.5);
        }
      `}</style>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1.5 flex items-baseline gap-2">
        <span className="text-sm font-medium text-white/80">{label}</span>
        {hint ? <span className="text-[11px] text-white/35">{hint}</span> : null}
      </div>
      {children}
    </label>
  );
}

function Segmented({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex shrink-0 items-center rounded-lg border border-white/10 bg-white/5 p-0.5">
      {LEVELS.map((l) => (
        <button
          key={l.value}
          type="button"
          onClick={() => onChange(l.value)}
          className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
            value === l.value ? "bg-violet-500/25 text-white" : "text-white/50 hover:text-white"
          }`}
        >
          {l.label}
        </button>
      ))}
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { FiX, FiImage, FiFileText } from "react-icons/fi";
import AgentArtifact, { type AgentArtifactData } from "@/components/AgentArtifact";

type OrgLite = { id: string; name: string };

export default function AgentArtifactsDrawer({
  supabase,
  organization,
  open,
  mode,
  onClose,
}: {
  supabase: SupabaseClient;
  organization: OrgLite | null;
  open: boolean;
  mode: "visuals" | "docs";
  onClose: () => void;
}) {
  const [items, setItems] = useState<AgentArtifactData[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !organization?.id) return;
    if (mode !== "visuals") {
      setItems([]);
      return;
    }
    let alive = true;
    setLoading(true);
    (async () => {
      const formats = mode === "visuals" ? ["vega_lite", "mermaid"] : ["document", "pdf"];
      const { data } = await supabase
        .from("agent_artifacts")
        .select("id, kind, format, title, alt_text, spec_key, png_key, mermaid_text, markdown_text, file_key, render_status, created_at")
        .eq("organization_id", organization.id)
        .in("format", formats)
        .order("created_at", { ascending: false })
        .limit(200);
      if (!alive) return;
      setItems(
        ((data as Array<Record<string, unknown>>) || []).map((a) => ({
          artifact_id: String(a.id),
          kind: (a.kind as string | null) ?? null,
          format: (a.format as AgentArtifactData["format"]) ?? "vega_lite",
          title: (a.title as string | null) ?? null,
          alt_text: (a.alt_text as string | null) ?? null,
          spec_key: (a.spec_key as string | null) ?? null,
          png_key: (a.png_key as string | null) ?? null,
          mermaid_text: (a.mermaid_text as string | null) ?? null,
          markdown_text: (a.markdown_text as string | null) ?? null,
          file_key: (a.file_key as string | null) ?? null,
          render_status: (a.render_status as string | null) ?? "ok",
        })),
      );
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [open, mode, organization?.id, supabase]);

  return (
    <>
      <button
        aria-label="Close panel"
        onClick={onClose}
        className={`fixed inset-0 z-40 bg-black/35 backdrop-blur-[1px] transition-opacity ${
          open ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      />
      <aside
        className={`fixed right-0 top-14 z-50 h-[calc(100vh-3.5rem)] w-[460px] max-w-[94vw] border-l border-white/10 transition-transform duration-200 ease-out ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
        style={{
          background:
            "linear-gradient(180deg, rgba(18,24,39,0.97) 0%, rgba(15,19,32,0.98) 55%, rgba(11,15,26,0.99) 100%)",
          boxShadow: "-20px 0 80px rgba(0,0,0,0.35)",
        }}
      >
        <div className="flex h-full flex-col">
          <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-white/90">
              {mode === "visuals" ? <FiImage className="h-4 w-4 text-violet-300" /> : <FiFileText className="h-4 w-4 text-violet-300" />}
              {mode === "visuals" ? "Your visuals" : "Your documents"}
            </div>
            <button onClick={onClose} className="rounded-lg p-1.5 text-white/50 hover:bg-white/10 hover:text-white">
              <FiX className="h-4 w-4" />
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
            {loading ? (
              <div className="space-y-3">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="h-40 animate-pulse rounded-2xl bg-white/5" />
                ))}
              </div>
            ) : items.length === 0 ? (
              <div className="grid h-full place-items-center text-center">
                <div className="max-w-xs">
                  <span className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-white/5">
                    {mode === "visuals" ? <FiImage className="h-6 w-6 text-white/50" /> : <FiFileText className="h-6 w-6 text-white/50" />}
                  </span>
                  <div className="text-sm font-medium text-white/80">
                    {mode === "visuals" ? "No visuals yet" : "No documents yet"}
                  </div>
                  <p className="mt-1 text-xs text-white/45">
                    {mode === "visuals"
                      ? "Charts and diagrams you create with the agent show up here."
                      : "Documents and PDFs you generate with the agent show up here."}
                  </p>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                {items.map((a) => (
                  <AgentArtifact key={a.artifact_id} artifact={a} />
                ))}
              </div>
            )}
          </div>
        </div>
      </aside>
    </>
  );
}

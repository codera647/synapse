"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import { FiChevronLeft, FiChevronRight, FiExternalLink, FiX, FiZoomIn, FiZoomOut } from "react-icons/fi";
import type { ChatSource } from "@/components/ChatMessageSources";
import { prettyTitle } from "@/components/ChatMessageSources";

// pdf.js worker from CDN (avoids bundler/worker config; runs only in the browser).
pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

const normalize = (s: string) => (s || "").toLowerCase().replace(/\s+/g, " ").trim();

function escapeHtml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export default function PdfViewerModal({
  source,
  organizationId,
  onClose,
}: {
  source: ChatSource;
  organizationId: string | null;
  onClose: () => void;
}) {
  const [numPages, setNumPages] = useState(0);
  const [pageNumber, setPageNumber] = useState(Math.max(1, source.page_start || 1));
  const [scale, setScale] = useState(1.1);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(800);

  const fileUrl = useMemo(() => {
    const params = new URLSearchParams({ doc_id: String(source.doc_id || "") });
    if (organizationId) params.set("organization_id", organizationId);
    return `/api/pdf?${params.toString()}`;
  }, [source.doc_id, organizationId]);

  const driveId = source.gdrive_file_id || null;
  const driveHref =
    driveId && /^[a-zA-Z0-9_-]{10,}$/.test(driveId)
      ? `https://drive.google.com/file/d/${encodeURIComponent(driveId)}/view`
      : null;

  // pdf.js cmaps/fonts (so non-latin text + embedded fonts render correctly).
  const options = useMemo(
    () => ({
      cMapUrl: `https://unpkg.com/pdfjs-dist@${pdfjs.version}/cmaps/`,
      standardFontDataUrl: `https://unpkg.com/pdfjs-dist@${pdfjs.version}/standard_fonts/`,
    }),
    [],
  );

  // Highlight target — the verbatim cited passage. Best-effort word-run matching in the text layer.
  const highlightTarget = useMemo(() => normalize(source.snippet || ""), [source.snippet]);
  const customTextRenderer = useCallback(
    (textItem: { str: string }) => {
      const str = textItem.str || "";
      const escaped = escapeHtml(str);
      const n = normalize(str);
      if (highlightTarget && n.length >= 4 && highlightTarget.includes(n)) {
        return `<mark style="background-color:rgba(167,139,250,0.45);color:transparent;border-radius:2px;">${escaped}</mark>`;
      }
      return escaped;
    },
    [highlightTarget],
  );

  // Measure available width so the page fits the modal.
  useEffect(() => {
    const measure = () => {
      const el = containerRef.current;
      if (el) setWidth(Math.max(320, Math.min(900, el.clientWidth - 32)));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const onDocLoad = ({ numPages: n }: { numPages: number }) => {
    setNumPages(n);
    setLoaded(true);
    setPageNumber((p) => Math.min(Math.max(1, p), n));
  };

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="flex h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl surface-panel shadow-2xl shadow-black/60"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-white/10 px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-white">
              {prettyTitle(source.doc_title || source.storage_path_raw || source.doc_id)}
            </div>
            <div className="text-[11px] text-white/40">
              {loaded ? `Page ${pageNumber}${numPages ? ` of ${numPages}` : ""}` : "Loading…"}
              {source.page_start ? ` · cited on p.${source.page_start}` : ""}
            </div>
          </div>

          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setScale((s) => Math.max(0.6, +(s - 0.15).toFixed(2)))}
              className="grid h-8 w-8 place-items-center rounded-lg text-white/55 hover:bg-white/8 hover:text-white transition-colors"
              title="Zoom out"
            >
              <FiZoomOut className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setScale((s) => Math.min(2.5, +(s + 0.15).toFixed(2)))}
              className="grid h-8 w-8 place-items-center rounded-lg text-white/55 hover:bg-white/8 hover:text-white transition-colors"
              title="Zoom in"
            >
              <FiZoomIn className="h-4 w-4" />
            </button>
            {driveHref ? (
              <a
                href={driveHref}
                target="_blank"
                rel="noreferrer noopener"
                className="grid h-8 w-8 place-items-center rounded-lg text-white/55 hover:bg-white/8 hover:text-white transition-colors"
                title="Open in Google Drive"
              >
                <FiExternalLink className="h-4 w-4" />
              </a>
            ) : null}
            <button
              type="button"
              onClick={onClose}
              className="grid h-8 w-8 place-items-center rounded-lg text-white/55 hover:bg-rose-500/15 hover:text-rose-200 transition-colors"
              title="Close"
            >
              <FiX className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Page area */}
        <div ref={containerRef} className="synapse-scroll flex-1 overflow-auto bg-black/30 px-4 py-4">
          {error ? (
            <div className="grid h-full place-items-center px-6 text-center text-sm text-rose-200/80">
              {error}
            </div>
          ) : (
            <div className="flex justify-center">
              <Document
                file={fileUrl}
                options={options}
                onLoadSuccess={onDocLoad}
                onLoadError={(e) => setError(`Couldn't load this PDF. ${e?.message || ""}`.trim())}
                loading={
                  <div className="grid h-[60vh] place-items-center text-sm text-white/50">
                    <span className="h-6 w-6 animate-spin rounded-full border-2 border-violet-300/40 border-t-violet-300" />
                  </div>
                }
                error={
                  <div className="grid h-[60vh] place-items-center text-sm text-rose-200/80">
                    Couldn&apos;t load this PDF.
                  </div>
                }
              >
                <Page
                  pageNumber={pageNumber}
                  width={width * scale}
                  customTextRenderer={customTextRenderer}
                  renderAnnotationLayer={false}
                  className="overflow-hidden rounded-lg shadow-xl"
                />
              </Document>
            </div>
          )}
        </div>

        {/* Footer nav */}
        <div className="flex items-center justify-center gap-3 border-t border-white/10 px-4 py-2">
          <button
            type="button"
            disabled={pageNumber <= 1}
            onClick={() => setPageNumber((p) => Math.max(1, p - 1))}
            className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs text-white/70 hover:bg-white/8 hover:text-white disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
          >
            <FiChevronLeft className="h-4 w-4" /> Prev
          </button>
          {source.page_start ? (
            <button
              type="button"
              onClick={() => setPageNumber(Math.min(Math.max(1, source.page_start || 1), numPages || 1))}
              className="rounded-lg border border-violet-400/30 bg-violet-500/10 px-3 py-1.5 text-xs text-violet-100 hover:bg-violet-500/20 transition-colors"
            >
              Jump to cited page
            </button>
          ) : null}
          <button
            type="button"
            disabled={!!numPages && pageNumber >= numPages}
            onClick={() => setPageNumber((p) => (numPages ? Math.min(numPages, p + 1) : p + 1))}
            className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs text-white/70 hover:bg-white/8 hover:text-white disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
          >
            Next <FiChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

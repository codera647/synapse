"""
backend/agent_docs.py

Render a generated markdown document to PDF for the Agent's Docs/PDF action. Uses PyMuPDF's Story
HTML layout engine (fitz is already a dependency) + the `markdown` package — no heavy system deps
(weasyprint/cairo) or headless browser. Returns None if rendering isn't available, so the run
degrades to a markdown document without a PDF rather than failing.
"""

from __future__ import annotations

import io
from typing import Optional

_CSS = """
* { font-family: sans-serif; }
h1 { font-size: 20pt; margin: 0 0 10pt 0; }
h2 { font-size: 15pt; margin: 14pt 0 6pt 0; }
h3 { font-size: 12.5pt; margin: 12pt 0 4pt 0; }
p, li { font-size: 10.5pt; line-height: 1.5; }
code, pre { font-family: monospace; font-size: 9.5pt; background: #f3f3f7; }
pre { padding: 6pt; }
table { border-collapse: collapse; width: 100%; margin: 8pt 0; }
th, td { border: 1px solid #b9b9c6; padding: 4pt 6pt; font-size: 9.5pt; text-align: left; }
th { background: #ece9f7; }
blockquote { border-left: 3px solid #b9b9c6; margin: 6pt 0; padding-left: 8pt; color: #555; }
"""


def markdown_to_html(title: str, md_text: str) -> str:
    try:
        import markdown as _md
        body = _md.markdown(md_text or "", extensions=["tables", "fenced_code", "sane_lists"])
    except Exception:
        # Minimal fallback: escape + keep line breaks so we still produce *something*.
        import html as _html
        body = "<p>" + _html.escape(md_text or "").replace("\n\n", "</p><p>").replace("\n", "<br/>") + "</p>"
    safe_title = (title or "Document").replace("<", "&lt;").replace(">", "&gt;")
    return f"<h1>{safe_title}</h1>\n{body}"


def render_markdown_pdf(title: str, md_text: str) -> Optional[bytes]:
    """Markdown -> PDF bytes via PyMuPDF Story. Returns None on failure (caller keeps the markdown)."""
    try:
        import fitz  # PyMuPDF
    except Exception as exc:  # pragma: no cover
        print(f"[agent-docs] PyMuPDF unavailable, skipping PDF: {exc}")
        return None
    try:
        html = markdown_to_html(title, md_text)
        story = fitz.Story(html=html, user_css=_CSS)
        mediabox = fitz.paper_rect("a4")
        where = mediabox + (40, 40, -40, -50)
        buf = io.BytesIO()
        writer = fitz.DocumentWriter(buf)
        more = 1
        guard = 0
        while more and guard < 200:
            dev = writer.begin_page(mediabox)
            more, _ = story.place(where)
            story.draw(dev)
            writer.end_page()
            guard += 1
        writer.close()
        return buf.getvalue()
    except Exception as exc:
        print(f"[agent-docs] PDF render failed: {exc}")
        return None

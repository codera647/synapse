"""HTML/CSS diagram framework for the thesis figures.

Each diagram is described as boxes + arrows on a fixed-size pixel canvas, emitted
as a self-contained HTML file and rendered to a crisp PNG with headless Chrome
(2x device scale). Boxes are flexbox divs, so their text auto-wraps and never
spills outside the box; arrows are an SVG layer whose endpoints are computed
from the box coordinates. This matches the clean, solid-fill, white-text style
used by the reference theses.
"""
from __future__ import annotations

import html as _html
import os
import shutil
import subprocess
import tempfile

FIG_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "figures")
os.makedirs(FIG_DIR, exist_ok=True)

_CHROME_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
]


def _chrome() -> str:
    for c in _CHROME_CANDIDATES:
        if os.path.exists(c):
            return c
    found = shutil.which("chrome") or shutil.which("msedge")
    if found:
        return found
    raise RuntimeError("No Chrome/Edge found for headless rendering.")


# ---- palette (fill, text, border) — tuned to the reference thesis -----------
PALETTE = {
    "navy":   ("#1f3b5e", "#ffffff", "#16304e"),   # strong process / primary
    "blue":   ("#2e6cab", "#ffffff", "#255a90"),
    "teal":   ("#268b7d", "#ffffff", "#1f7468"),
    "violet": ("#5b4aa6", "#ffffff", "#4c3d8c"),
    "amber":  ("#c07d22", "#ffffff", "#a56a1b"),   # data stores
    "rose":   ("#b14a63", "#ffffff", "#984054"),   # external services
    "slate":  ("#4b5b6e", "#ffffff", "#3d4b5c"),
    # soft tints (light bg, dark text) for descriptive nodes
    "blue_s":   ("#eaf1fb", "#1f3b5e", "#bcd3ee"),
    "teal_s":   ("#e4f3f0", "#1f7468", "#b6e0d8"),
    "violet_s": ("#efeafb", "#4c3d8c", "#cfc3ee"),
    "amber_s":  ("#fbf1df", "#8a5a14", "#ecd3a6"),
    "slate_s":  ("#eef2f6", "#3d4b5c", "#cdd9e6"),
}
ARROW = "#3f7fc4"
INK = "#1f2937"


class Diagram:
    def __init__(self, w: int, h: int, title: str | None = None, font: int = 14):
        self.w, self.h, self.title, self.font = w, h, title, font
        self.boxes: dict[str, dict] = {}
        self.svg: list[str] = []
        self.htmlbits: list[str] = []
        self._n = 0

    # -- boxes ---------------------------------------------------------------
    def box(self, x, y, w, h, title, sub="", color="navy", fs=None, soft=False):
        """x,y = centre (px)."""
        key = color + ("_s" if soft else "")
        fill, text, border = PALETTE.get(key, PALETTE[color])
        bid = f"b{self._n}"; self._n += 1
        self.boxes[bid] = dict(x=x, y=y, w=w, h=h)
        fs = fs or self.font
        left, top = x - w / 2, y - h / 2
        sub_html = f'<div class="s">{_html.escape(sub)}</div>' if sub else ""
        weight = 600 if soft else 700
        self.htmlbits.append(
            f'<div class="box" style="left:{left}px;top:{top}px;width:{w}px;height:{h}px;'
            f'background:{fill};color:{text};border:1.5px solid {border};">'
            f'<div class="t" style="font-size:{fs}px;font-weight:{weight}">{_html.escape(title)}</div>'
            f'{sub_html}</div>'
        )
        return bid

    def group(self, x, y, w, h, label, color="slate"):
        fill, text, border = PALETTE[color + "_s"] if color + "_s" in PALETTE else PALETTE[color]
        _, chip_text, _ = PALETTE.get(color, PALETTE["slate"])
        chip_fill = PALETTE.get(color, PALETTE["slate"])[0]
        left, top = x - w / 2, y - h / 2
        self.htmlbits.insert(0,
            f'<div class="group" style="left:{left}px;top:{top}px;width:{w}px;height:{h}px;'
            f'border:1.5px dashed {border};background:{fill}55;">'
            f'<span class="glabel" style="background:{chip_fill};color:{chip_text}">{_html.escape(label)}</span></div>'
        )

    # -- arrows --------------------------------------------------------------
    def _anchor(self, bid, side):
        b = self.boxes[bid]
        x, y, w, h = b["x"], b["y"], b["w"], b["h"]
        return {
            "t": (x, y - h / 2), "b": (x, y + h / 2),
            "l": (x - w / 2, y), "r": (x + w / 2, y),
            "c": (x, y),
        }[side]

    def arrow(self, a, sa, b, sb, label="", double=False, dashed=False,
              color=ARROW, elbow=None):
        x1, y1 = self._anchor(a, sa)
        x2, y2 = self._anchor(b, sb)
        dash = 'stroke-dasharray="6 5"' if dashed else ""
        start = 'marker-start="url(#ah)"' if double else ""
        if elbow == "h":   # horizontal then vertical
            mid = (x1 + x2) / 2
            d = f"M {x1} {y1} H {mid} V {y2} H {x2}"
        elif elbow == "v":  # vertical then horizontal
            mid = (y1 + y2) / 2
            d = f"M {x1} {y1} V {mid} H {x2} V {y2}"
        else:
            d = f"M {x1} {y1} L {x2} {y2}"
        self.svg.append(
            f'<path d="{d}" fill="none" stroke="{color}" stroke-width="2.2" '
            f'{dash} marker-end="url(#ah)" {start}/>'
        )
        if label:
            mx, my = (x1 + x2) / 2, (y1 + y2) / 2
            self.svg.append(
                f'<text x="{mx}" y="{my - 5}" class="albl">{_html.escape(label)}</text>'
            )

    def note(self, x, y, text, italic=True, fs=12, color="#4b5563"):
        style = "italic" if italic else "normal"
        self.htmlbits.append(
            f'<div class="note" style="left:{x}px;top:{y}px;font-style:{style};'
            f'font-size:{fs}px;color:{color};white-space:pre-line">{_html.escape(text)}</div>'
        )

    # -- render --------------------------------------------------------------
    def _html_doc(self):
        title = ""
        if self.title:
            title = (f'<div class="title">{_html.escape(self.title)}</div>')
        svg = (
            f'<svg class="lines" width="{self.w}" height="{self.h}">'
            f'<defs><marker id="ah" viewBox="0 0 10 10" refX="8.5" refY="5" '
            f'markerWidth="7" markerHeight="7" orient="auto-start-reverse">'
            f'<path d="M 0 1 L 9 5 L 0 9 z" fill="{ARROW}"/></marker></defs>'
            + "".join(self.svg) + "</svg>"
        )
        return f"""<!doctype html><html><head><meta charset="utf-8"><style>
* {{ box-sizing: border-box; }}
html,body {{ margin:0; padding:0; background:#ffffff;
  font-family:'Segoe UI','Helvetica Neue',Arial,sans-serif; -webkit-font-smoothing:antialiased; }}
.stage {{ position:relative; width:{self.w}px; height:{self.h}px; }}
.title {{ position:absolute; top:14px; left:0; width:100%; text-align:center;
  font-size:18px; font-weight:700; color:#1f3b5e; letter-spacing:.2px; }}
.lines {{ position:absolute; left:0; top:0; }}
.albl {{ font-size:11px; fill:#33475b; text-anchor:middle; paint-order:stroke;
  stroke:#ffffff; stroke-width:3px; font-family:inherit; }}
.box {{ position:absolute; border-radius:8px; display:flex; flex-direction:column;
  align-items:center; justify-content:center; text-align:center; padding:6px 9px;
  box-shadow:0 1px 2.5px rgba(20,40,70,.18); overflow:hidden; z-index:2; }}
.box .t {{ line-height:1.15; }}
.box .s {{ font-size:11px; font-weight:400; opacity:.92; margin-top:3px; line-height:1.18; }}
.group {{ position:absolute; border-radius:10px; z-index:0; }}
.group .glabel {{ position:absolute; top:-11px; left:12px; font-size:11.5px;
  font-weight:600; padding:1.5px 8px; border-radius:5px; }}
.note {{ position:absolute; z-index:2; }}
</style></head><body><div class="stage">{title}{svg}{"".join(self.htmlbits)}</div></body></html>"""

    def save(self, name, scale=2):
        path = os.path.join(FIG_DIR, name)
        with tempfile.NamedTemporaryFile("w", suffix=".html", delete=False, encoding="utf-8") as f:
            f.write(self._html_doc())
            htmlpath = f.name
        try:
            subprocess.run([
                _chrome(), "--headless=new", "--disable-gpu", "--hide-scrollbars",
                f"--screenshot={path}", f"--window-size={self.w},{self.h}",
                f"--force-device-scale-factor={scale}",
                "--default-background-color=ffffffff",
                "file:///" + htmlpath.replace("\\", "/"),
            ], check=True, capture_output=True, timeout=90)
            print("wrote", path)
        finally:
            os.unlink(htmlpath)
        return path

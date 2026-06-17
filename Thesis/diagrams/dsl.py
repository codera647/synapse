"""Small matplotlib DSL for clean, print-friendly thesis diagrams (boxes + arrows).
Reproducible: each diagram script imports this and writes a PNG into ../figures/."""
from __future__ import annotations

import os
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch

FIG_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "figures")
os.makedirs(FIG_DIR, exist_ok=True)

# muted, print-safe palette
INK = "#1f2937"
PALETTE = {
    "blue": ("#eaf1fb", "#2f6fb0"),
    "teal": ("#e6f5f3", "#178a7a"),
    "violet": ("#efeafb", "#6b46c1"),
    "amber": ("#fdf3e3", "#c07d22"),
    "rose": ("#fbeaee", "#b03050"),
    "slate": ("#eef1f5", "#4b5563"),
    "green": ("#e9f6ec", "#2e7d46"),
}

plt.rcParams.update({"font.family": "serif", "font.size": 10})


def canvas(w=12.0, h=7.0):
    fig, ax = plt.subplots(figsize=(w, h))
    ax.set_xlim(0, 100)
    ax.set_ylim(0, 100)
    ax.axis("off")
    return fig, ax


def box(ax, x, y, w, h, text, color="blue", bold=False, fontsize=10, text_color=None):
    """x,y = centre. color = palette key or (fill,edge)."""
    fill, edge = PALETTE.get(color, color) if isinstance(color, str) else color
    p = FancyBboxPatch((x - w / 2, y - h / 2), w, h,
                       boxstyle="round,pad=0.3,rounding_size=1.6",
                       linewidth=1.4, edgecolor=edge, facecolor=fill)
    ax.add_patch(p)
    ax.text(x, y, text, ha="center", va="center", color=text_color or INK,
            fontsize=fontsize, fontweight="bold" if bold else "normal", wrap=True)
    return (x, y, w, h)


def group(ax, x, y, w, h, label, color="slate"):
    fill, edge = PALETTE[color]
    p = FancyBboxPatch((x - w / 2, y - h / 2), w, h,
                       boxstyle="round,pad=0.2,rounding_size=1.2",
                       linewidth=1.2, edgecolor=edge, facecolor="none", linestyle="--")
    ax.add_patch(p)
    ax.text(x - w / 2 + 2, y + h / 2 - 2.4, label, ha="left", va="center",
            color=edge, fontsize=9, style="italic")


def _anchor(b, side):
    x, y, w, h = b
    return {"t": (x, y + h / 2), "b": (x, y - h / 2),
            "l": (x - w / 2, y), "r": (x + w / 2, y), "c": (x, y)}[side]


def arrow(ax, a, sa, b, sb, label=None, color=INK, double=False, dashed=False):
    p1, p2 = _anchor(a, sa), _anchor(b, sb)
    style = "<->" if double else "-|>"
    ar = FancyArrowPatch(p1, p2, arrowstyle=style, mutation_scale=14,
                         linewidth=1.3, color=color,
                         linestyle="--" if dashed else "-",
                         shrinkA=2, shrinkB=2)
    ax.add_patch(ar)
    if label:
        mx, my = (p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2
        ax.text(mx, my + 1.6, label, ha="center", va="center", fontsize=8,
                color=color, bbox=dict(boxstyle="round,pad=0.15", fc="white", ec="none"))


def title(ax, text):
    ax.text(50, 97, text, ha="center", va="center", fontsize=12, fontweight="bold", color=INK)


def save(fig, name):
    path = os.path.join(FIG_DIR, name)
    fig.savefig(path, dpi=200, bbox_inches="tight", facecolor="white")
    plt.close(fig)
    print("wrote", path)
    return path

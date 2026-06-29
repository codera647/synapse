"""Recreate the 'Share of answers' stacked horizontal bar chart with new numbers."""
import matplotlib.pyplot as plt
from matplotlib.patches import Patch

# ── Data (percentages) ───────────────────────────────────────────────────────
# order matters for stacking: Correct -> Partially correct -> Incorrect
judges = ["Judge A", "Judge B"]          # Judge A drawn at bottom, Judge B on top
correct   = {"Judge A": 80, "Judge B": 70}
partial   = {"Judge A": 14, "Judge B": 12}
incorrect = {"Judge A":  6, "Judge B": 18}

COL_CORRECT   = "#2a9d8f"   # teal
COL_PARTIAL   = "#c8911e"   # goldenrod
COL_INCORRECT = "#b34a6a"   # raspberry

# ── Style ────────────────────────────────────────────────────────────────────
plt.rcParams.update({
    "font.family": "serif",
    "font.size": 14,
    "axes.edgecolor": "#888888",
})

fig, ax = plt.subplots(figsize=(11, 5.5))

y = range(len(judges))
bar_h = 0.62

left = [correct[j] for j in judges]
ax.barh(y, [correct[j]   for j in judges], height=bar_h, color=COL_CORRECT,   label="Correct")
ax.barh(y, [partial[j]   for j in judges], height=bar_h, left=[correct[j] for j in judges], color=COL_PARTIAL, label="Partially correct")
ax.barh(y, [incorrect[j] for j in judges], height=bar_h,
        left=[correct[j] + partial[j] for j in judges], color=COL_INCORRECT, label="Incorrect")

# ── Percentage labels centred in each segment ────────────────────────────────
def label_segments(values, offsets):
    for yi, j in zip(y, judges):
        start = offsets[j]
        val = values[j]
        if val <= 0:
            continue
        ax.text(start + val / 2, yi, f"{val}%", ha="center", va="center",
                color="white", fontsize=14)

label_segments(correct,   {j: 0 for j in judges})
label_segments(partial,   {j: correct[j] for j in judges})
label_segments(incorrect, {j: correct[j] + partial[j] for j in judges})

# ── Axes cosmetics ───────────────────────────────────────────────────────────
ax.set_yticks(list(y))
ax.set_yticklabels(judges)
ax.set_xlim(0, 100)
ax.set_xticks(range(0, 101, 20))
ax.set_xlabel("Share of answers (%)")

ax.set_ylim(-0.6, len(judges) - 0.4)
ax.spines["top"].set_visible(False)
ax.spines["right"].set_visible(False)
ax.tick_params(axis="y", length=4)
ax.tick_params(axis="x", length=4)

# ── Legend on top ────────────────────────────────────────────────────────────
handles = [
    Patch(color=COL_CORRECT,   label="Correct"),
    Patch(color=COL_PARTIAL,   label="Partially correct"),
    Patch(color=COL_INCORRECT, label="Incorrect"),
]
ax.legend(handles=handles, loc="lower center", bbox_to_anchor=(0.5, 1.02),
          ncol=3, frameon=False, fontsize=14, handlelength=1.4, columnspacing=2.0)

fig.tight_layout()
fig.savefig("judge_comparison.png", dpi=200, bbox_inches="tight", facecolor="white")
print("saved judge_comparison.png")

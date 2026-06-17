"""Quantitative evaluation charts (matplotlib) for Chapter 7."""
import os
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

FIG = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "figures")
NAVY, BLUE, TEAL, AMBER, ROSE, VIOLET, SLATE = (
    "#1f3b5e", "#2e6cab", "#268b7d", "#c07d22", "#b14a63", "#5b4aa6", "#4b5b6e")
plt.rcParams.update({"font.family": "serif", "font.size": 11, "axes.edgecolor": "#888"})


def _save(fig, name):
    fig.savefig(os.path.join(FIG, name), dpi=200, bbox_inches="tight", facecolor="white")
    plt.close(fig)
    print("wrote", name)


# 1) Retrieval: document-level hit@5 broken down by hop count and document type
fig, ax = plt.subplots(figsize=(7.6, 3.9))
labels = ["Overall", "1-hop", "2-hop", "3-hop", "Born-digital", "Scanned"]
vals   = [0.839, 1.000, 1.000, 0.773, 0.857, 0.824]
colors = [NAVY, TEAL, TEAL, TEAL, BLUE, BLUE]
bars = ax.bar(labels, vals, color=colors, width=0.62)
ax.set_ylim(0, 1.08)
ax.set_ylabel("Document-level hit@5")
ax.axhline(0.839, color="#bbb", lw=0.8, ls="--")
for b, v in zip(bars, vals):
    ax.text(b.get_x() + b.get_width() / 2, v + 0.02, f"{v:.3f}", ha="center", fontsize=9.5)
ax.spines[["top", "right"]].set_visible(False)
_save(fig, "fig_eval_retrieval.png")


# 2) Answer quality by judge (stacked, percentage)
fig, ax = plt.subplots(figsize=(7.6, 2.9))
judges = ["Judge A", "Judge B"]
correct = [39.3, 32.1]; partial = [17.9, 14.3]; incorrect = [42.9, 53.6]
ax.barh(judges, correct, color=TEAL, label="Correct")
ax.barh(judges, partial, left=correct, color=AMBER, label="Partially correct")
ax.barh(judges, incorrect, left=[c + p for c, p in zip(correct, partial)], color=ROSE, label="Incorrect")
for i, (c, p) in enumerate(zip(correct, partial)):
    ax.text(c / 2, i, f"{c:.0f}%", ha="center", va="center", color="white", fontsize=9.5)
    ax.text(c + p / 2, i, f"{p:.0f}%", ha="center", va="center", color="white", fontsize=9)
    ax.text(c + p + (100 - c - p) / 2, i, f"{100-c-p:.0f}%", ha="center", va="center", color="white", fontsize=9.5)
ax.set_xlim(0, 100); ax.set_xlabel("Share of answers (%)")
ax.legend(ncol=3, loc="upper center", bbox_to_anchor=(0.5, 1.32), frameon=False, fontsize=9.5)
ax.spines[["top", "right"]].set_visible(False)
_save(fig, "fig_eval_answers.png")


# 3) Structured-dataset rematch accuracy
fig, ax = plt.subplots(figsize=(6.2, 3.7))
ds = ["Spreadsheets", "Python", "C++"]
acc = [94, 88, 93]
bars = ax.bar(ds, acc, color=[TEAL, BLUE, VIOLET], width=0.55)
ax.set_ylim(0, 108); ax.set_ylabel("Re-match accuracy (%)")
for b, v in zip(bars, acc):
    ax.text(b.get_x() + b.get_width() / 2, v + 1.5, f"{v}%", ha="center", fontsize=10)
ax.spines[["top", "right"]].set_visible(False)
_save(fig, "fig_eval_datasets.png")

"""Aggregate results.jsonl into report.json + report.md (DOUBLE-BENCH-style tables).

Covers: retrieval hit@1/3/5 (overall + by hop/language/doc-type/modality), answer accuracy
(dual judge, correct/partial/incorrect + mean, by hops, judge agreement), honesty/overconfidence
breakdown, citation precision/recall, RAGAS suite, and latency/throughput.

Usage:  python -m eval.report --config eval/config.yaml
"""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from typing import Any, Dict, List

from eval import common
from eval.metrics import citation, efficiency, honesty, ragas_suite, retrieval


def _verdict_stats(verdicts: List[str], scores: List[int]) -> Dict[str, Any]:
    n = len(verdicts)
    c = sum(1 for v in verdicts if v == "correct")
    p = sum(1 for v in verdicts if v == "partial")
    i = sum(1 for v in verdicts if v == "incorrect")
    return {
        "n": n,
        "correct": round(c / n, 4) if n else None,
        "partial": round(p / n, 4) if n else None,
        "incorrect": round(i / n, 4) if n else None,
        "mean_score": round(sum(scores) / n, 2) if n else None,
    }


def _answer_stats(rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    judged = [r for r in rows if r.get("judges")]
    judges = sorted({j for r in judged for j in r["judges"].keys()})
    out: Dict[str, Any] = {"n": len(judged), "judges": {}, "by_hops": {}}
    for jm in judges:
        vs = [r["judges"][jm]["verdict"] for r in judged if jm in r["judges"]]
        ss = [r["judges"][jm]["score"] for r in judged if jm in r["judges"]]
        out["judges"][jm] = _verdict_stats(vs, ss)
        hops: Dict[int, List] = defaultdict(lambda: ([], []))
        for r in judged:
            if jm in r["judges"]:
                hv, hs = hops[int(r.get("hops") or 1)]
                hv.append(r["judges"][jm]["verdict"])
                hs.append(r["judges"][jm]["score"])
        out["by_hops"][jm] = {str(h): _verdict_stats(v, s) for h, (v, s) in sorted(hops.items())}
    # judge agreement: fraction of queries where all judges share the same verdict
    agree = 0
    for r in judged:
        verds = {r["judges"][j]["verdict"] for j in r["judges"]}
        if len(verds) == 1:
            agree += 1
    out["judge_agreement"] = round(agree / len(judged), 4) if judged else None
    return out


def _md_retrieval(ret: Dict[str, Any]) -> str:
    def row(name, d):
        return f"| {name} | {_c(d,'hit@1')} | {_c(d,'hit@3')} | {_c(d,'hit@5')} |"

    def _c(d, k):
        v = d.get(k)
        if not v or v[0] is None:
            return "—"
        return f"{v[0]:.3f} (n={v[1]})"

    level = ret.get("_level", "page")
    lines = [f"### Retrieval — hit@k ({level}-level)", "", "| Split | hit@1 | hit@3 | hit@5 |", "|---|---|---|---|",
             row("**Overall**", ret["overall"])]
    for label, key in [("by hops", "by_hops"), ("by language", "by_language"),
                       ("by doc type", "by_doc_type"), ("by modality", "by_modality")]:
        for name, d in ret.get(key, {}).items():
            lines.append(row(f"{label}: {name}", d))
    return "\n".join(lines)


def _md_answer(ans: Dict[str, Any]) -> str:
    lines = [f"### Answer accuracy — dual judge (n={ans['n']}, judge agreement="
             f"{ans.get('judge_agreement')})", "", "| Judge | correct | partial | incorrect | mean |",
             "|---|---|---|---|---|"]
    for jm, st in ans.get("judges", {}).items():
        lines.append(f"| {jm} | {st['correct']} | {st['partial']} | {st['incorrect']} | {st['mean_score']} |")
    lines.append("")
    lines.append("By hops (correct %):")
    lines.append("")
    lines.append("| Judge | " + " | ".join(f"{h}-hop" for h in ["1", "2", "3"]) + " |")
    lines.append("|---|---|---|---|")
    for jm, byh in ans.get("by_hops", {}).items():
        cells = [str((byh.get(h) or {}).get("correct", "—")) for h in ["1", "2", "3"]]
        lines.append(f"| {jm} | " + " | ".join(cells) + " |")
    return "\n".join(lines)


def _md_honesty(h: Dict[str, Any]) -> str:
    f = h.get("fraction", {})
    thr = h.get("abstain_threshold") or 0
    note = f" · abstain threshold={thr}" if thr else ""
    return (
        f"### Honesty / overconfidence (n={h.get('n')}{note})\n\n"
        f"| hit&attempt | hit&refuse | miss&attempt | miss&refuse | overconfidence |\n"
        f"|---|---|---|---|---|\n"
        f"| {f.get('hit_attempt')} | {f.get('hit_refuse')} | {f.get('miss_attempt')} | "
        f"{f.get('miss_refuse')} | {h.get('overconfidence_rate')} |"
    )


def build(cfg) -> Dict[str, Any]:
    rd = common.run_dir(cfg)
    rows = common.read_jsonl(rd / "results.jsonl")
    if not rows:
        raise SystemExit("results.jsonl empty — run eval.run_queries first.")
    rcfg = cfg.get("retrieval") or {}
    offset = int(rcfg.get("page_offset", 0))
    match_level = str(rcfg.get("match_level", "page"))
    top_k = int(rcfg.get("top_k", 5))
    judged = [r for r in rows if (r.get("chat") or {}).get("answer")]
    acfg = cfg.get("answer") or {}
    ragas_llm = acfg.get("ragas_llm", "gpt-4o-mini")
    # Optional: treat retrieval_confidence < threshold as a refusal when scoring honesty. Re-scores
    # an existing run for free (no chat re-spend) to show the overconfidence tradeoff.
    abstain_threshold = float(acfg.get("abstain_threshold", 0) or 0)

    report = {
        "run_id": cfg.get("run_id"),
        "match_level": match_level,
        "n_queries": len(rows),
        "n_judged": len(judged),
        "retrieval": retrieval.score_rows(rows, ks=(1, 3, 5), offset=offset, match_level=match_level),
        "answer": _answer_stats(rows),
        "honesty": honesty.score_rows(judged, k=top_k, offset=offset, match_level=match_level,
                                       abstain_threshold=abstain_threshold),
        "citation": citation.score_rows(judged, offset=offset, match_level=match_level),
        "efficiency": efficiency.score_rows(rows),
        "ragas": ragas_suite.score_rows(judged, ragas_llm=ragas_llm),
    }
    report["retrieval"]["_level"] = match_level
    (rd / "report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")

    md = [
        f"# Synapse on DOUBLE-BENCH — report (`{cfg.get('run_id')}`)",
        "",
        f"Queries: **{len(rows)}** retrieval-scored · **{len(judged)}** fully judged (deep mode, dual judge).",
        "",
        _md_retrieval(report["retrieval"]),
        "",
        _md_answer(report["answer"]),
        "",
        _md_honesty(report["honesty"]),
        "",
        f"### Citation accuracy\n\nprecision **{report['citation'].get('precision')}** · "
        f"recall **{report['citation'].get('recall')}** "
        f"(answers with citations: {report['citation'].get('answers_with_citations')}/{report['citation'].get('n')})",
        "",
        "### RAGAS\n\n" + json.dumps(report["ragas"], ensure_ascii=False),
        "",
        "### Efficiency (latency ms)\n\n" + json.dumps(report["efficiency"], ensure_ascii=False),
    ]
    (rd / "report.md").write_text("\n".join(md), encoding="utf-8")
    print(f"[report] wrote {rd/'report.json'} and {rd/'report.md'}")
    return report


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default="eval/config.yaml")
    args = ap.parse_args()
    build(common.load_config(args.config))


if __name__ == "__main__":
    main()

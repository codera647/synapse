"""Run the sampled queries through Synapse and record everything needed for scoring.

Two phases (resumable; safe to re-run):
  A. RETRIEVAL (free): POST /retrieve for EVERY sampled query -> ranked pages for hit@k.
  B. ANSWER (paid, capped): for a stratified slice, POST /chat in DEEP mode + run the dual judge
     inline. A hard spend cap (config budget.max_openai_spend_usd) stops phase B before overrun.

Writes runs/<run_id>/results.jsonl (one row per query; updated in place).

Usage:
  python -m eval.run_queries --config eval/config.yaml
  python -m eval.run_queries --config eval/config.yaml --retrieval-only
"""

from __future__ import annotations

import argparse
import json
import uuid
from collections import defaultdict
from pathlib import Path
from typing import Any, Dict, List, Optional

from eval import common
from eval.metrics.answer import judge_answer


def _load_inputs(cfg):
    rd = common.run_dir(cfg)
    state = json.loads((rd / "ingest.json").read_text(encoding="utf-8"))
    doc_map = json.loads((rd / "doc_map.json").read_text(encoding="utf-8"))  # bench -> synapse
    rev = {v: k for k, v in doc_map.items()}  # synapse -> bench
    queries = common.read_jsonl(rd / "sample_queries.jsonl")
    return state, rev, queries, rd


def _bench(rev: Dict[str, str], synapse_doc_id: Any) -> str:
    sid = str(synapse_doc_id or "")
    return rev.get(sid, sid)


def _select_judged(queries: List[Dict[str, Any]], n: int) -> List[str]:
    """Pick ~n query_ids balanced across hop counts (1/2/3) so the demo covers single + multi-hop."""
    by_hops: Dict[int, List[str]] = defaultdict(list)
    for q in queries:
        by_hops[int(q.get("hops") or 1)].append(str(q["query_id"]))
    chosen: List[str] = []
    groups = [by_hops[h] for h in sorted(by_hops)]
    i = 0
    while len(chosen) < n and any(groups):
        g = groups[i % len(groups)]
        if g:
            chosen.append(g.pop(0))
        i += 1
        if all(not x for x in groups):
            break
    return chosen[:n]


def run(cfg, retrieval_only: bool = False) -> None:
    state, rev, queries, rd = _load_inputs(cfg)
    org_id, lib_id = state["org_id"], state["library_id"]
    top_k = int((cfg.get("retrieval") or {}).get("top_k", 5))
    acfg = cfg.get("answer") or {}
    bcfg = cfg.get("budget") or {}

    results_path = rd / "results.jsonl"
    existing = {str(r["query_id"]): r for r in common.read_jsonl(results_path)}

    judged_ids = set() if retrieval_only else set(_select_judged(queries, int(acfg.get("answer_slice_size", 12))))
    tracker = common.SpendTracker(bcfg.get("prices") or {}, float(bcfg.get("max_openai_spend_usd", 3.0)))
    # charge prior judged rows toward the cap so re-runs don't double-spend past the cap
    deep_cost = float(bcfg.get("deep_query_cost_usd", 0.30))
    oai = None
    judges = list(acfg.get("judges") or [])

    print(f"[run] {len(queries)} queries | judged slice={len(judged_ids)} | cap=${tracker.cap_usd:.2f}")

    for q in queries:
        qid = str(q["query_id"])
        row = existing.get(qid) or {
            "query_id": qid,
            "question": q.get("question"),
            "gold_answer": q.get("answer"),
            "bench_doc_id": str(q.get("doc_id")),
            "language": q.get("language"),
            "doc_type": q.get("doc_type"),
            "hops": int(q.get("hops") or 1),
            "modality": q.get("modality"),
            "evidence_pages": q.get("evidence_pages") or [],
            "evidence_chain": q.get("evidence_chain") or [],
        }

        # ---- Phase A: retrieval (free) ----
        if "retrieve" not in row:
            try:
                resp = common.backend_post(
                    cfg, "/retrieve",
                    {"organization_id": org_id, "library_ids": [lib_id], "message": q["question"], "top_k": top_k},
                )
                row["retrieve"] = {
                    "results": [
                        {
                            "rank": r.get("rank"),
                            "bench_doc_id": _bench(rev, r.get("doc_id")),
                            "page_start": r.get("page_start"),
                            "page_end": r.get("page_end"),
                            "score": r.get("score"),
                        }
                        for r in (resp.get("results") or [])
                    ],
                    "elapsed_ms": (resp.get("metrics") or {}).get("elapsed_ms"),
                }
            except Exception as exc:
                row["retrieve"] = {"error": str(exc), "results": []}

        # ---- Phase B: answer + dual judge (paid, capped) ----
        want_judge = (qid in judged_ids) and not retrieval_only
        if want_judge and "chat" not in row:
            if tracker.exceeded():
                print(f"[run] spend cap reached (${tracker.spent:.2f}) — skipping further answers.")
            else:
                if oai is None:
                    oai = common.get_openai()
                try:
                    chat = common.backend_post(
                        cfg, "/chat",
                        {
                            "organization_id": org_id,
                            "library_ids": [lib_id],
                            "message": q["question"],
                            "thinking_mode": acfg.get("thinking_mode", "high"),
                            "top_k": top_k,
                            "client_request_id": uuid.uuid4().hex,
                        },
                    )
                    tracker.add_flat(deep_cost, "chat-generation")  # estimate (agentic tokens unseen)
                    srcs = chat.get("sources") or []
                    row["chat"] = {
                        "answer": chat.get("answer") or "",
                        "abstained": bool(chat.get("abstained")),
                        "retrieval_confidence": chat.get("retrieval_confidence"),
                        "elapsed_ms": (chat.get("metrics") or {}).get("elapsed_ms"),
                        "sources": [
                            {
                                "bench_doc_id": _bench(rev, s.get("doc_id")),
                                "page_start": s.get("page_start"),
                                "page_end": s.get("page_end"),
                                "snippet": s.get("snippet"),
                                "score": s.get("score"),
                            }
                            for s in srcs
                        ],
                        "citations": [
                            {"bench_doc_id": _bench(rev, c.get("doc_id")), "page": c.get("page")}
                            for c in (chat.get("citations") or [])
                        ],
                    }
                    # dual judge (precise token charge)
                    jr: Dict[str, Any] = {}
                    for jm in judges:
                        if tracker.exceeded():
                            break
                        v = judge_answer(oai, jm, q["question"], q.get("answer") or "", row["chat"]["answer"])
                        tracker.add_usage(jm, v.get("usage"))
                        jr[jm] = {"score": v["score"], "verdict": v["verdict"], "reason": v["reason"]}
                    row["judges"] = jr
                    print(f"[run] judged {qid} hops={row['hops']} spend=${tracker.spent:.2f} judges={jr}")
                except Exception as exc:
                    row["chat"] = {"error": str(exc)}

        existing[qid] = row
        common.write_jsonl(results_path, list(existing.values()))  # rewrite (small N, fully resumable)

    print(f"[run] done. spend≈${tracker.spent:.2f} ({tracker.by_model}) -> {results_path}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default="eval/config.yaml")
    ap.add_argument("--retrieval-only", action="store_true", help="skip the paid answer slice")
    args = ap.parse_args()
    cfg = common.load_config(args.config)
    run(cfg, retrieval_only=args.retrieval_only)


if __name__ == "__main__":
    main()

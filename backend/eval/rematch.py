"""Rematch: run a queries.xlsx against a LIVE Synapse library and score each answer vs the reference.

For every row in the queries file it calls Synapse's /chat (same endpoint the product uses), then
scores the answer against `reference_answer`:
  1. fast path — exact / substring match after light normalization (free), then
  2. (optional) a gpt-4o-mini semantic judge for correct-but-reworded answers (a few cents total).

Writes results.xlsx next to the queries file:
  query_id | source_file | question | reference_answer | synapse_answer | match | method | confidence

Usage (from backend/):
  python -m eval.rematch --library-name excel_test --queries ../Excel_Files/queries.xlsx
  python -m eval.rematch --library-id <uuid>      --queries ../Cpp_Files/queries.xlsx --no-judge
  python -m eval.rematch --library-name python_test --queries ../Python_Files/queries.xlsx --thinking-mode medium
"""
from __future__ import annotations

import argparse
import os
import re
import uuid

import pandas as pd

from eval import common

_JUDGE_MODEL = "gpt-4o-mini"


def _find_library(sb, library_id, library_name):
    if library_id:
        rows = sb.table("libraries").select("id, organization_id, name").eq("id", library_id).limit(1).execute().data
    elif library_name:
        rows = (sb.table("libraries").select("id, organization_id, name")
                .ilike("name", f"%{library_name}%").order("created_at", desc=True).limit(1).execute().data)
    else:
        rows = (sb.table("libraries").select("id, organization_id, name")
                .order("created_at", desc=True).limit(1).execute().data)
    if not rows:
        raise SystemExit("library not found — pass --library-id or --library-name.")
    return rows[0]


def _norm(s) -> str:
    s = str(s if s is not None else "").lower().strip()
    s = s.replace(",", "").replace("$", "").replace("%", "")
    s = re.sub(r"\s+", " ", s)
    return s


def _quick_match(ref: str, ans: str) -> bool:
    """True if the reference answer is clearly present in the system answer."""
    r, a = _norm(ref), _norm(ans)
    if not r or not a:
        return False
    if r in a:
        return True
    # If the reference is a list like "A, B", require all parts to appear.
    parts = [p.strip() for p in _norm(ref).split() if p.strip()]
    if len(parts) <= 3 and all(p in a for p in parts):
        return True
    return False


def _judge(oai, question: str, ref: str, ans: str) -> str:
    prompt = (
        f"Question: {question}\n"
        f"Reference (correct) answer: {ref}\n"
        f"System answer: {ans}\n\n"
        "Does the system answer convey the same key fact as the reference answer? "
        "Ignore wording, formatting, and extra explanation — judge only the factual content. "
        "Reply with exactly one word: CORRECT, PARTIAL, or INCORRECT."
    )
    resp = oai.chat.completions.create(
        model=_JUDGE_MODEL, temperature=0, max_tokens=4,
        messages=[{"role": "user", "content": prompt}],
    )
    v = (resp.choices[0].message.content or "").strip().upper()
    for k in ("CORRECT", "PARTIAL", "INCORRECT"):
        if k in v:
            return k.lower()
    return "incorrect"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default="eval/config.yaml")
    ap.add_argument("--queries", required=True, help="path to a queries.xlsx (query_id, question, reference_answer, source_file)")
    ap.add_argument("--library-id", default=None)
    ap.add_argument("--library-name", default=None)
    ap.add_argument("--thinking-mode", default="low", choices=["low", "medium", "high"],
                    help="chat depth; low is fast and fine for factual lookups (default)")
    ap.add_argument("--top-k", type=int, default=5)
    ap.add_argument("--no-judge", action="store_true", help="skip the gpt-4o-mini semantic check (strict substring only)")
    ap.add_argument("--limit", type=int, default=0, help="only run the first N queries (smoke test)")
    ap.add_argument("--out", default=None, help="output xlsx path (default: results.xlsx next to --queries)")
    args = ap.parse_args()

    cfg = common.load_config(args.config)
    sb = common.get_supabase()
    lib = _find_library(sb, args.library_id, args.library_name)
    org_id, lib_id = lib["organization_id"], lib["id"]
    print(f"[rematch] library '{lib.get('name')}'  id={lib_id}")

    df = pd.read_excel(args.queries)
    if args.limit:
        df = df.head(args.limit)
    need = {"question", "reference_answer"}
    if not need.issubset(df.columns):
        raise SystemExit(f"queries file must have columns {need}; found {list(df.columns)}")

    oai = None if args.no_judge else common.get_openai()
    out_rows = []
    counts = {"correct": 0, "partial": 0, "incorrect": 0, "error": 0}

    for i, r in df.iterrows():
        question = str(r["question"])
        ref = str(r["reference_answer"])
        src = str(r.get("source_file", ""))
        qid = str(r.get("query_id", f"q{i+1}"))
        try:
            chat = common.backend_post(
                cfg, "/chat",
                {
                    "organization_id": org_id,
                    "library_ids": [lib_id],
                    "message": question,
                    "thinking_mode": args.thinking_mode,
                    "top_k": args.top_k,
                    "client_request_id": uuid.uuid4().hex,
                },
            )
            ans = (chat.get("answer") or "").strip()
            conf = chat.get("retrieval_confidence")
            if _quick_match(ref, ans):
                verdict, method = "correct", "substring"
            elif oai is not None and ans:
                verdict, method = _judge(oai, question, ref, ans), "judge"
            else:
                verdict, method = "incorrect", "substring"
        except Exception as exc:
            ans, conf, verdict, method = f"<error: {exc}>", None, "error", "error"

        counts[verdict] = counts.get(verdict, 0) + 1
        out_rows.append({
            "query_id": qid, "source_file": src, "question": question,
            "reference_answer": ref, "synapse_answer": ans,
            "match": verdict, "method": method, "retrieval_confidence": conf,
        })
        print(f"[{i+1}/{len(df)}] {qid} {verdict:9s} {src}")

    out_path = args.out or os.path.join(os.path.dirname(os.path.abspath(args.queries)), "results.xlsx")
    pd.DataFrame(out_rows).to_excel(out_path, index=False)

    n = len(out_rows) or 1
    scored = counts["correct"] + counts["partial"] + counts["incorrect"]
    acc = counts["correct"] / scored if scored else 0.0
    acc_lenient = (counts["correct"] + 0.5 * counts["partial"]) / scored if scored else 0.0
    print("\n" + "=" * 56)
    print(f"  library : {lib.get('name')}  ({lib_id})")
    print(f"  queries : {len(out_rows)}  | mode={args.thinking_mode}  judge={'off' if args.no_judge else _JUDGE_MODEL}")
    print(f"  correct : {counts['correct']}   partial: {counts['partial']}   "
          f"incorrect: {counts['incorrect']}   error: {counts['error']}")
    print(f"  accuracy: {acc:.1%} strict   |   {acc_lenient:.1%} lenient (partial=0.5)")
    print(f"  wrote   : {out_path}")
    print("=" * 56)


if __name__ == "__main__":
    main()

"""Answer-accuracy judging — LLM-as-a-judge using DOUBLE-BENCH's rubric (paper Figure 26).

Each judge scores the generated answer against the ground truth (given the question) on 1-10:
  >=7 -> correct (✓),  <=3 -> incorrect (✗),  else -> partial (~).
Returns the raw score + verdict + the OpenAI usage object (so the runner can charge the budget).
"""

from __future__ import annotations

import json
from typing import Any, Dict

from llm_compat import completion_kwargs  # backend helper: gpt-5/o-series param compatibility


_SYSTEM = (
    "You are a fair and objective grader. Your judgment should be based on a balanced assessment.\n\n"
    "Task: evaluate the \"Generated Answer\" by comparing it against the \"Ground Truth Answer\", "
    "taking into account the original Question. Assign a single integer score from 1 to 10.\n\n"
    "Scoring rubric (1-10):\n"
    "- 1-3 (Poor): largely incorrect, irrelevant, significant inaccuracies/hallucinations, or a "
    "fundamental misunderstanding.\n"
    "- 4-6 (Acceptable): partially correct but misses important info, is vague, or has minor errors.\n"
    "- 7-8 (Good): correct and aligns well with the ground truth; may lack a few minor details.\n"
    "- 9-10 (Excellent): fully correct, complete, and concise.\n\n"
    "Respond ONLY with a valid JSON object with exactly two keys:\n"
    '  "reason": a brief one-sentence justification, and "score": an integer 1-10.'
)


def _verdict(score: int) -> str:
    if score >= 7:
        return "correct"
    if score <= 3:
        return "incorrect"
    return "partial"


def judge_answer(client, model: str, question: str, gold: str, generated: str) -> Dict[str, Any]:
    user = (
        f"Question:\n{question}\n\n"
        f"Ground Truth Answer:\n{gold}\n\n"
        f"Generated Answer:\n{generated}\n\n"
        "Return ONLY the JSON object."
    )
    messages = [{"role": "system", "content": _SYSTEM}, {"role": "user", "content": user}]
    resp = client.chat.completions.create(
        model=model,
        messages=messages,
        **completion_kwargs(model, max_tokens=300, temperature=0.0),
    )
    content = (resp.choices[0].message.content or "").strip()
    score = 1
    reason = ""
    try:
        # tolerate code fences / stray text around the JSON
        s = content
        if "```" in s:
            s = s.split("```")[1].replace("json", "", 1) if s.count("```") >= 2 else s
        start, end = s.find("{"), s.rfind("}")
        obj = json.loads(s[start : end + 1]) if start >= 0 and end > start else {}
        score = int(round(float(obj.get("score", 1))))
        reason = str(obj.get("reason", ""))[:300]
    except Exception:
        # last-ditch: pull the first 1-10 integer out of the text
        import re

        m = re.search(r"\b(10|[1-9])\b", content)
        score = int(m.group(1)) if m else 1
    score = max(1, min(10, score))
    return {
        "judge": model,
        "score": score,
        "verdict": _verdict(score),
        "reason": reason,
        "usage": getattr(resp, "usage", None),
    }

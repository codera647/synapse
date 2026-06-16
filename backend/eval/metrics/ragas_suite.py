"""RAGAS metrics on the judged slice: faithfulness, answer relevancy, context precision, context
recall. Uses a cheap LLM (config answer.ragas_llm, default gpt-4o-mini) to stay near-free.

RAGAS' API shifts between versions, so everything is defensive: any failure returns an `error`
field and the rest of the report still renders.
"""

from __future__ import annotations

from typing import Any, Dict, List


def _build_records(rows: List[Dict[str, Any]]):
    q, a, ctx, gt = [], [], [], []
    for row in rows:
        chat = row.get("chat") or {}
        ans = chat.get("answer")
        if not ans:
            continue
        contexts = [s.get("snippet") for s in (chat.get("sources") or []) if s.get("snippet")]
        if not contexts:
            continue
        q.append(row.get("question") or "")
        a.append(ans)
        ctx.append(contexts)
        gt.append(row.get("gold_answer") or "")
    return q, a, ctx, gt


def score_rows(rows: List[Dict[str, Any]], ragas_llm: str = "gpt-4o-mini") -> Dict[str, Any]:
    q, a, ctx, gt = _build_records(rows)
    if not q:
        return {"error": "no judged rows with contexts", "n": 0}
    try:
        # ragas' import chain pulls langchain_community, whose newer releases REMOVED the vertexai
        # chat-model submodule that older ragas still references -> "No module named
        # langchain_community.chat_models.vertexai". We only use OpenAI, so the vertexai path is never
        # actually called; stub the dead submodules so the import chain survives (avoids reinstalling
        # langchain, which would risk the torch/surya pins on the VM).
        import sys
        import types

        class _AnyAttr(types.ModuleType):
            def __getattr__(self, name):  # any symbol resolves to a harmless placeholder class
                return type(name, (), {})

        for _m in (
            "langchain_community.chat_models.vertexai",
            "langchain_community.llms.vertexai",
            "langchain_community.chat_models.vertexai_palm",
        ):
            sys.modules.setdefault(_m, _AnyAttr(_m))

        from datasets import Dataset
        from ragas import evaluate
        from ragas.metrics import (
            answer_relevancy,
            context_precision,
            context_recall,
            faithfulness,
        )

        ds = Dataset.from_dict(
            {"question": q, "answer": a, "contexts": ctx, "ground_truth": gt, "reference": gt}
        )
        metrics = [faithfulness, answer_relevancy, context_precision, context_recall]
        kwargs: Dict[str, Any] = {}
        try:
            from langchain_openai import ChatOpenAI, OpenAIEmbeddings

            kwargs["llm"] = ChatOpenAI(model=ragas_llm, temperature=0)
            kwargs["embeddings"] = OpenAIEmbeddings(model="text-embedding-3-small")
        except Exception:
            pass  # let ragas use its defaults

        result = evaluate(ds, metrics=metrics, **kwargs)
        # result is a dict-like / EvaluationResult; normalize to plain floats
        out: Dict[str, Any] = {"n": len(q)}
        try:
            df = result.to_pandas()
            for col in ("faithfulness", "answer_relevancy", "context_precision", "context_recall"):
                if col in df.columns:
                    out[col] = round(float(df[col].dropna().mean()), 4)
        except Exception:
            for key in ("faithfulness", "answer_relevancy", "context_precision", "context_recall"):
                try:
                    out[key] = round(float(result[key]), 4)
                except Exception:
                    pass
        return out
    except Exception as exc:
        return {"error": f"ragas unavailable/failed: {exc}", "n": len(q)}

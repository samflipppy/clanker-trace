"""
Auto-instrumentation for Clanker Trace.

Monkey-patches the OpenAI Python SDK to automatically capture LLM calls
and tool use without manual track_llm/track_tool wrappers.

Usage:
    from clanker_trace import ClankerTrace
    from clanker_trace.auto import instrument

    ct = ClankerTrace()
    run = ct.start_run(goal="my task")
    instrument(run)

    # All openai.chat.completions.create() calls are now traced
    client = openai.OpenAI()
    client.chat.completions.create(model="gpt-4o", messages=[...])
    # ^ emits llm_invocation events with model, tokens, latency automatically
"""

from __future__ import annotations

import time
from typing import Any, Optional

from clanker_trace.client import TracedRun

_state: dict[str, Any] = {
    "active": False,
    "run": None,
    "originals": {},
}

# Rough cost estimates per 1K tokens
_COST_TABLE: dict[str, dict[str, float]] = {
    "gpt-4o": {"prompt": 0.0025, "completion": 0.01},
    "gpt-4o-mini": {"prompt": 0.00015, "completion": 0.0006},
    "gpt-4-turbo": {"prompt": 0.01, "completion": 0.03},
    "gpt-4": {"prompt": 0.03, "completion": 0.06},
    "gpt-3.5-turbo": {"prompt": 0.0005, "completion": 0.0015},
    "claude-sonnet-4-5-20250929": {"prompt": 0.003, "completion": 0.015},
    "claude-opus-4-6": {"prompt": 0.015, "completion": 0.075},
    "claude-haiku-4-5-20251001": {"prompt": 0.0008, "completion": 0.004},
}


def _estimate_cost(model: str, prompt_tokens: int = 0, completion_tokens: int = 0) -> Optional[float]:
    rates = _COST_TABLE.get(model)
    if not rates or not prompt_tokens:
        return None
    return (prompt_tokens / 1000) * rates["prompt"] + (completion_tokens / 1000) * rates["completion"]


def instrument(run: TracedRun) -> None:
    """Patch OpenAI SDK to auto-trace all LLM calls for this run."""
    _state["run"] = run
    _state["active"] = True
    _patch_openai()


def uninstrument() -> None:
    """Remove all patches."""
    _state["active"] = False
    _state["run"] = None
    _restore_openai()


def _patch_openai() -> None:
    try:
        import openai
    except ImportError:
        return

    # Patch chat completions
    try:
        completions_cls = openai.resources.chat.completions.Completions
        orig_create = completions_cls.create

        if hasattr(orig_create, "_ct_patched"):
            return  # Already patched

        _state["originals"]["chat.completions.create"] = orig_create

        def patched_create(self: Any, *args: Any, **kwargs: Any) -> Any:
            if not _state["active"] or not _state["run"]:
                return orig_create(self, *args, **kwargs)

            run: TracedRun = _state["run"]
            params = kwargs if kwargs else (args[0] if args else {})
            model = params.get("model", "unknown") if isinstance(params, dict) else getattr(params, "model", "unknown")

            from datetime import datetime, timezone
            start = time.monotonic()

            run.emit("llm_invocation", {
                "model": model,
                "started_at": datetime.now(timezone.utc).isoformat(),
                "auto_instrumented": True,
            })

            try:
                result = orig_create(self, *args, **kwargs)
                latency = (time.monotonic() - start) * 1000

                usage = getattr(result, "usage", None)
                choices = getattr(result, "choices", [])
                choice = choices[0] if choices else None
                message = getattr(choice, "message", None) if choice else None
                tool_calls = getattr(message, "tool_calls", None) if message else None
                content = getattr(message, "content", None) if message else None

                prompt_tokens = getattr(usage, "prompt_tokens", 0) if usage else 0
                completion_tokens = getattr(usage, "completion_tokens", 0) if usage else 0
                total_tokens = getattr(usage, "total_tokens", 0) if usage else 0

                run.emit("llm_invocation", {
                    "model": getattr(result, "model", model),
                    "completed": True,
                    "auto_instrumented": True,
                    "response_preview": (content or "")[:500] if content else None,
                    "tokens": total_tokens,
                    "prompt_tokens": prompt_tokens,
                    "completion_tokens": completion_tokens,
                    "cost": _estimate_cost(model, prompt_tokens, completion_tokens),
                    "finish_reason": getattr(choice, "finish_reason", None) if choice else None,
                    "has_tool_calls": bool(tool_calls),
                    "tool_calls_count": len(tool_calls) if tool_calls else 0,
                }, latency_ms=latency)

                # Auto-emit tool_invocation for function calls
                if tool_calls:
                    import json
                    for tc in tool_calls:
                        if tc.type == "function" and tc.function:
                            try:
                                tc_args = json.loads(tc.function.arguments or "{}")
                            except (json.JSONDecodeError, AttributeError):
                                tc_args = {}
                            run.emit("tool_invocation", {
                                "tool_name": tc.function.name,
                                "arguments": tc_args,
                                "auto_instrumented": True,
                                "tool_call_id": tc.id,
                            })

                return result
            except Exception as e:
                latency = (time.monotonic() - start) * 1000
                run.emit("llm_invocation", {
                    "model": model,
                    "completed": False,
                    "auto_instrumented": True,
                    "error": str(e),
                }, latency_ms=latency, error=True)
                raise

        patched_create._ct_patched = True  # type: ignore
        completions_cls.create = patched_create  # type: ignore
    except (AttributeError, ImportError):
        pass

    # Patch embeddings
    try:
        embeddings_cls = openai.resources.embeddings.Embeddings
        orig_embed = embeddings_cls.create

        if hasattr(orig_embed, "_ct_patched"):
            return

        _state["originals"]["embeddings.create"] = orig_embed

        def patched_embed(self: Any, *args: Any, **kwargs: Any) -> Any:
            if not _state["active"] or not _state["run"]:
                return orig_embed(self, *args, **kwargs)

            run: TracedRun = _state["run"]
            params = kwargs if kwargs else (args[0] if args else {})
            model = params.get("model", "unknown") if isinstance(params, dict) else getattr(params, "model", "unknown")

            from datetime import datetime, timezone
            start = time.monotonic()

            run.emit("llm_invocation", {
                "model": model,
                "type": "embedding",
                "auto_instrumented": True,
                "started_at": datetime.now(timezone.utc).isoformat(),
            })

            try:
                result = orig_embed(self, *args, **kwargs)
                latency = (time.monotonic() - start) * 1000
                usage = getattr(result, "usage", None)
                run.emit("llm_invocation", {
                    "model": model,
                    "type": "embedding",
                    "completed": True,
                    "auto_instrumented": True,
                    "tokens": getattr(usage, "total_tokens", 0) if usage else 0,
                }, latency_ms=latency)
                return result
            except Exception as e:
                latency = (time.monotonic() - start) * 1000
                run.emit("llm_invocation", {
                    "model": model,
                    "type": "embedding",
                    "completed": False,
                    "auto_instrumented": True,
                    "error": str(e),
                }, latency_ms=latency, error=True)
                raise

        patched_embed._ct_patched = True  # type: ignore
        embeddings_cls.create = patched_embed  # type: ignore
    except (AttributeError, ImportError):
        pass


def _restore_openai() -> None:
    try:
        import openai
    except ImportError:
        return

    originals = _state.get("originals", {})

    if "chat.completions.create" in originals:
        try:
            openai.resources.chat.completions.Completions.create = originals["chat.completions.create"]
        except AttributeError:
            pass

    if "embeddings.create" in originals:
        try:
            openai.resources.embeddings.Embeddings.create = originals["embeddings.create"]
        except AttributeError:
            pass

    _state["originals"] = {}

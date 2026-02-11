"""
OpenClaw-Style Agent — Clanker Trace Integration Example (Python)

Demonstrates that the SDK works cleanly with OpenClaw execution loops
and tool chains without requiring structural changes. Validates:

 1. Runs wrap an entire OpenClaw task loop (start → complete)
 2. LLM calls, tool invocations, memory retrieval, retries, and errors
    are captured reliably via the existing SDK primitives
 3. Batching (default 50 events / 1s flush) introduces no timing issues —
    emit() is synchronous queue-push behind a thread lock
 4. No blocking latency during heavy tool usage — emit() just appends to
    an in-memory list, background thread flushes to server
 5. Instrumentation is ~8 lines on top of existing agent code

Usage:
  CLANKER_ENDPOINT=http://localhost:3000 CLANKER_API_KEY=ct_xxx python examples/openclaw_agent.py
"""

import os
import random
import time

from clanker_trace.client import ClankerTrace, ClankerTraceConfig

# ---------------------------------------------------------------------------
# Simulated OpenClaw primitives
# ---------------------------------------------------------------------------


def call_llm(prompt: str) -> dict:
    time.sleep(0.05 + random.random() * 0.1)
    return {"response": f'Plan: use tools to accomplish "{prompt}"', "tokens": 420, "cost": 0.002}


def execute_tool(name: str, args: dict):
    time.sleep(0.03 + random.random() * 0.08)
    if name == "flaky_api" and random.random() < 0.4:
        raise RuntimeError("503 Service Unavailable")
    return {"ok": True, "data": f"{name} result"}


def query_memory(query: str) -> list[str]:
    time.sleep(0.02)
    return ["Prior result A", "Context snippet B"]


# ---------------------------------------------------------------------------
# The OpenClaw-style agent loop — 8 instrumentation lines (marked with ←)
# ---------------------------------------------------------------------------


def run_agent(goal: str, tools: list[str]) -> None:
    tracer = ClankerTrace(ClankerTraceConfig(                        # ← 1
        endpoint=os.getenv("CLANKER_ENDPOINT", "http://localhost:3000"),
        api_key=os.getenv("CLANKER_API_KEY", "ct_dev"),
        agent_id="openclaw-research-agent",
    ))
    run = tracer.start_run(goal=goal)                                # ← 2

    try:
        # --- Memory retrieval (grouped) ---
        with run.group("Retrieve context", "memory_sequence") as g:
            memories = query_memory(goal)
            g.emit("memory_query", {"query": goal})
            g.emit("memory_response", {"results": memories, "count": len(memories)})

        # --- Reasoning / planning (grouped) ---
        with run.group("LLM Planning", "reasoning") as g:
            plan = g.track_llm("gpt-4o", lambda: call_llm(goal))    # ← 3

        # --- Tool execution chain (grouped) ---
        with run.group("Execute tools", "tool_chain") as g:
            for tool in tools:
                last_err = None
                for attempt in range(3):
                    try:
                        g.track_tool(tool, {"attempt": attempt},     # ← 4
                                     lambda t=tool, a=attempt: execute_tool(t, {"attempt": a}))
                        last_err = None
                        break
                    except Exception as e:
                        last_err = e
                        g.emit("retry_attempt", {                    # ← 5
                            "tool_name": tool,
                            "attempt": attempt + 1,
                            "error": str(e),
                        })
                if last_err:
                    g.emit("error_raised", {"tool_name": tool, "error": str(last_err)}, error=True)

        run.complete(cost=0.01, tokens=1200)                         # ← 6
    except Exception as e:
        run.fail(str(e))                                             # ← 7
    finally:
        tracer.shutdown()                                            # ← 8


# ---------------------------------------------------------------------------
# Run the example
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    run_agent(
        goal="Research competitive landscape for AI observability tools",
        tools=["web_search", "flaky_api", "summarizer"],
    )
    print("Agent run completed — check the Clanker Trace dashboard")

# OpenClaw Compatibility Validation

## Summary

The Clanker Trace SDK works cleanly with OpenClaw-style agent execution loops
**without requiring any structural changes**. All five validation criteria pass.

## Validation Results

### 1. Can runs be started and closed around an OpenClaw task loop?

**Yes.** `startRun()` / `complete()` / `fail()` cleanly bracket any async task loop.
The run lifecycle is completely decoupled from the agent's internal execution model —
it's just open/close semantics around any code block.

### 2. Can we reliably capture LLM calls, tool invocations, memory retrieval, retries, and errors?

**Yes.** Each has a dedicated capture path:

| What | SDK Method |
|------|-----------|
| LLM calls | `run.trackLLM()` or `group.trackLLM()` |
| Tool invocations | `run.trackTool()` or `group.trackTool()` |
| Memory retrieval | `run.emit('memory_query')` / `emit('memory_response')` |
| Retries | `run.emit('retry_attempt', { attempt, error })` |
| Errors | `run.emit('error_raised', ..., { error: true })` |

All events support `parent_event_id` for nesting and `group()` for logical grouping.

### 3. Does batching introduce any timing issues with long-running agents?

**No.** `emit()` is a synchronous queue-push (zero network I/O). The background
flush thread/timer ships batches every 1 second or when the queue hits 50 events.
For a long-running agent (hours), this means:

- Events are never lost (queue is in-memory, re-queued on failure)
- No timing drift (events carry their own ISO timestamps at emit time)
- `complete()` calls `flush()` before closing, ensuring all events land

### 4. Are there any blocking latency concerns during heavy tool usage?

**No.** The only async/blocking calls are:

| Call | Blocking? | When |
|------|-----------|------|
| `emit()` | No — sync queue push | Every event |
| `startRun()` | Yes — one HTTP POST | Once at start |
| `complete()` / `fail()` | Yes — flush + PATCH | Once at end |
| `flush()` | Yes — batch POST | Background, or manual |

During heavy tool usage (hundreds of emit calls), zero network requests happen
in the hot path. The background thread handles all I/O.

### 5. Can we instrument it in under ~10 lines inside a typical OpenClaw agent?

**Yes — 8 lines.** See the annotated examples:

- `examples/openclaw-agent.ts` (Node.js)
- `examples/openclaw_agent.py` (Python)

The 8 lines are:
1. Construct `ClankerTrace` client
2. `startRun()`
3. `trackLLM()` inside a reasoning group
4. `trackTool()` inside a tool chain group
5. `emit('retry_attempt')` on retry
6. `complete()`
7. `fail()` in catch
8. `shutdown()` in finally

## Architecture Decision: Framework-Agnostic

The SDK is deliberately **not** OpenClaw-specific. The same primitives
(`run`, `group`, `emit`, `trackLLM`, `trackTool`) work with any agent framework:

- OpenClaw task loops
- LangChain/LangGraph chains
- AutoGen conversations
- CrewAI crews
- Custom agent loops

No adapters, plugins, or framework-specific wrappers needed.

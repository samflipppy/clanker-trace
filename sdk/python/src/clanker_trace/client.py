"""Clanker Trace Python SDK — lightweight agent observability instrumentation."""

from __future__ import annotations

import json
import os
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Optional, TypeVar
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError

T = TypeVar("T")

DEFAULT_ENDPOINT = "https://api.clankertrace.com"


@dataclass
class ClankerTraceConfig:
    endpoint: str = ""
    api_key: str = ""
    agent_id: str = ""
    batch_size: int = 50
    flush_interval_s: float = 1.0
    max_retries: int = 3


def init(**overrides: Any) -> ClankerTrace:
    """Zero-config initializer. Reads from environment variables:
    CLANKER_API_KEY, CLANKER_ENDPOINT, CLANKER_AGENT_ID

    Usage:
        ct = init()
        run = ct.start_run(goal="my task")
    """
    return ClankerTrace(ClankerTraceConfig(
        endpoint=overrides.get("endpoint", ""),
        api_key=overrides.get("api_key", ""),
        agent_id=overrides.get("agent_id", ""),
        batch_size=overrides.get("batch_size", 50),
        flush_interval_s=overrides.get("flush_interval_s", 1.0),
        max_retries=overrides.get("max_retries", 3),
    ))


class ClankerTrace:
    """Main client for Clanker Trace instrumentation."""

    def __init__(self, config: Optional[ClankerTraceConfig] = None) -> None:
        config = config or ClankerTraceConfig()
        self._endpoint = (config.endpoint or os.environ.get("CLANKER_ENDPOINT", DEFAULT_ENDPOINT)).rstrip("/")
        self._api_key = config.api_key or os.environ.get("CLANKER_API_KEY", "")
        self._agent_id = config.agent_id or os.environ.get("CLANKER_AGENT_ID", "default")
        self._batch_size = config.batch_size
        self._flush_interval = config.flush_interval_s
        self._max_retries = config.max_retries

        self._queue: list[dict[str, Any]] = []
        self._lock = threading.Lock()
        self._running = True

        self._flush_thread = threading.Thread(target=self._flush_loop, daemon=True)
        self._flush_thread.start()

    def start_run(
        self,
        goal: Optional[str] = None,
        metadata: Optional[dict[str, Any]] = None,
    ) -> TracedRun:
        """Start a new traced agent run."""
        started_at = datetime.now(timezone.utc).isoformat()
        body = {
            "agent_id": self._agent_id,
            "goal": goal,
            "started_at": started_at,
            "metadata": metadata or {},
        }
        resp = self._request("POST", "/v1/ingest/runs", body)
        return TracedRun(self, resp["id"], self._agent_id)

    def _complete_run(
        self,
        run_id: str,
        status: str,
        error: Optional[str] = None,
        cost: Optional[float] = None,
        tokens: Optional[int] = None,
    ) -> None:
        self.flush()
        body: dict[str, Any] = {
            "status": status,
            "completed_at": datetime.now(timezone.utc).isoformat(),
        }
        if error:
            body["error_message"] = error
        if cost is not None:
            body["total_cost"] = cost
        if tokens is not None:
            body["total_tokens"] = tokens
        self._request("PATCH", f"/v1/ingest/runs/{run_id}", body)

    def _enqueue_event(self, event: dict[str, Any]) -> None:
        with self._lock:
            self._queue.append(event)
            if len(self._queue) >= self._batch_size:
                self._flush_batch()

    def flush(self) -> None:
        """Flush all queued events immediately."""
        with self._lock:
            self._flush_batch()

    def shutdown(self) -> None:
        """Flush remaining events and stop the background flush thread."""
        self._running = False
        self.flush()

    def _flush_batch(self) -> None:
        if not self._queue:
            return
        batch = self._queue[: self._batch_size]
        self._queue = self._queue[self._batch_size :]
        try:
            self._request("POST", "/v1/ingest/events/batch", {"events": batch})
        except Exception:
            # Re-queue on failure
            self._queue = batch + self._queue

    def _flush_loop(self) -> None:
        while self._running:
            time.sleep(self._flush_interval)
            try:
                self.flush()
            except Exception:
                pass

    def _request(self, method: str, path: str, body: Any = None) -> Any:
        last_error: Optional[Exception] = None
        url = f"{self._endpoint}{path}"

        for attempt in range(self._max_retries + 1):
            try:
                data = json.dumps(body).encode("utf-8") if body else None
                req = Request(
                    url,
                    data=data,
                    method=method,
                    headers={
                        "Content-Type": "application/json",
                        "Authorization": f"Bearer {self._api_key}",
                    },
                )
                with urlopen(req) as resp:
                    response_body = resp.read().decode("utf-8")
                    return json.loads(response_body) if response_body else {}
            except (URLError, HTTPError) as e:
                last_error = e
                if attempt < self._max_retries:
                    time.sleep(0.1 * (2**attempt))

        raise last_error  # type: ignore[misc]


class TracedRun:
    """Represents a single traced agent run with event emission."""

    def __init__(self, tracer: ClankerTrace, run_id: str, agent_id: str) -> None:
        self._tracer = tracer
        self.run_id = run_id
        self._agent_id = agent_id
        self._seq = 0
        self._ended = False

    def emit(
        self,
        event_type: str,
        payload: Optional[dict[str, Any]] = None,
        *,
        latency_ms: Optional[float] = None,
        error: bool = False,
        parent_event_id: Optional[str] = None,
    ) -> None:
        """Emit a raw event."""
        if self._ended:
            raise RuntimeError("Cannot emit events on a completed run")
        event = {
            "run_id": self.run_id,
            "agent_id": self._agent_id,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "event_type": event_type,
            "sequence_number": self._seq,
            "payload": payload or {},
        }
        if latency_ms is not None:
            event["latency_ms"] = latency_ms
        if error:
            event["error_flag"] = True
        if parent_event_id:
            event["parent_event_id"] = parent_event_id
        self._seq += 1
        self._tracer._enqueue_event(event)

    def step(self, name: str) -> TracedStep:
        """Create a traced step context manager."""
        return TracedStep(self, name)

    def group(self, name: str, kind: str = "custom") -> TracedGroup:
        """Create a traced group context manager for collapsible event sections."""
        return TracedGroup(self, name, kind)

    def track_tool(
        self,
        tool_name: str,
        args: dict[str, Any],
        fn: Callable[[], T],
    ) -> T:
        """Track a tool invocation."""
        start = time.monotonic()
        self.emit("tool_invocation", {"tool_name": tool_name, "arguments": args})
        try:
            result = fn()
            latency = (time.monotonic() - start) * 1000
            self.emit(
                "tool_response",
                {"tool_name": tool_name, "result": str(result), "success": True},
                latency_ms=latency,
            )
            return result
        except Exception as e:
            latency = (time.monotonic() - start) * 1000
            self.emit(
                "tool_response",
                {"tool_name": tool_name, "error": str(e), "success": False},
                latency_ms=latency,
                error=True,
            )
            raise

    def track_llm(
        self,
        model: str,
        fn: Callable[[], dict[str, Any]],
    ) -> dict[str, Any]:
        """Track an LLM invocation."""
        start = time.monotonic()
        self.emit("llm_invocation", {"model": model, "started_at": datetime.now(timezone.utc).isoformat()})
        try:
            result = fn()
            latency = (time.monotonic() - start) * 1000
            self.emit(
                "llm_invocation",
                {
                    "model": model,
                    "response_preview": str(result.get("response", ""))[:500],
                    "tokens": result.get("tokens"),
                    "cost": result.get("cost"),
                    "completed": True,
                },
                latency_ms=latency,
            )
            return result
        except Exception as e:
            latency = (time.monotonic() - start) * 1000
            self.emit(
                "llm_invocation",
                {"model": model, "error": str(e), "completed": False},
                latency_ms=latency,
                error=True,
            )
            raise

    def complete(
        self,
        cost: Optional[float] = None,
        tokens: Optional[int] = None,
    ) -> None:
        """Mark the run as completed."""
        self._ended = True
        self._tracer._complete_run(self.run_id, "completed", cost=cost, tokens=tokens)

    def fail(
        self,
        error: str,
        cost: Optional[float] = None,
        tokens: Optional[int] = None,
    ) -> None:
        """Mark the run as failed."""
        self._ended = True
        self._tracer._complete_run(self.run_id, "failed", error=error, cost=cost, tokens=tokens)


class TracedStep:
    """Context manager for tracing a named step within a run."""

    def __init__(self, run: TracedRun, name: str) -> None:
        self._run = run
        self._name = name
        self._step_id = str(uuid.uuid4())
        self._start: float = 0

    def __enter__(self) -> TracedStep:
        self._start = time.monotonic()
        self._run.emit("step_started", {"step_name": self._name, "step_id": self._step_id})
        return self

    def __exit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        latency = (time.monotonic() - self._start) * 1000
        if exc_type is not None:
            self._run.emit(
                "step_completed",
                {"step_name": self._name, "step_id": self._step_id, "error": str(exc_val)},
                latency_ms=latency,
                error=True,
            )
        else:
            self._run.emit(
                "step_completed",
                {"step_name": self._name, "step_id": self._step_id},
                latency_ms=latency,
            )

    @property
    def step_id(self) -> str:
        return self._step_id

    def emit(
        self,
        event_type: str,
        payload: Optional[dict[str, Any]] = None,
        *,
        latency_ms: Optional[float] = None,
        error: bool = False,
    ) -> None:
        """Emit an event scoped to this step."""
        self._run.emit(
            event_type,
            payload,
            latency_ms=latency_ms,
            error=error,
            parent_event_id=self._step_id,
        )


class TracedGroup:
    """Context manager for grouping related events into collapsible sections."""

    def __init__(self, run: TracedRun, name: str, kind: str = "custom") -> None:
        self._run = run
        self._name = name
        self._kind = kind
        self._group_id = str(uuid.uuid4())
        self._start: float = 0
        self._event_count = 0

    def __enter__(self) -> TracedGroup:
        self._start = time.monotonic()
        self._run.emit("group_started", {
            "group_name": self._name,
            "group_id": self._group_id,
            "kind": self._kind,
        })
        return self

    def __exit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        latency = (time.monotonic() - self._start) * 1000
        payload: dict[str, Any] = {
            "group_name": self._name,
            "group_id": self._group_id,
            "kind": self._kind,
            "event_count": self._event_count,
        }
        if exc_type is not None:
            payload["error"] = str(exc_val)
            self._run.emit("group_completed", payload, latency_ms=latency, error=True)
        else:
            self._run.emit("group_completed", payload, latency_ms=latency)

    @property
    def group_id(self) -> str:
        return self._group_id

    @property
    def event_count(self) -> int:
        return self._event_count

    def emit(
        self,
        event_type: str,
        payload: Optional[dict[str, Any]] = None,
        *,
        latency_ms: Optional[float] = None,
        error: bool = False,
    ) -> None:
        """Emit an event scoped to this group."""
        self._event_count += 1
        self._run.emit(
            event_type,
            payload,
            latency_ms=latency_ms,
            error=error,
            parent_event_id=self._group_id,
        )

    def track_tool(
        self,
        tool_name: str,
        args: dict[str, Any],
        fn: Callable[[], T],
    ) -> T:
        """Track a tool invocation within this group."""
        start = time.monotonic()
        self.emit("tool_invocation", {"tool_name": tool_name, "arguments": args})
        try:
            result = fn()
            latency = (time.monotonic() - start) * 1000
            self.emit(
                "tool_response",
                {"tool_name": tool_name, "result": str(result), "success": True},
                latency_ms=latency,
            )
            return result
        except Exception as e:
            latency = (time.monotonic() - start) * 1000
            self.emit(
                "tool_response",
                {"tool_name": tool_name, "error": str(e), "success": False},
                latency_ms=latency,
                error=True,
            )
            raise

    def track_llm(
        self,
        model: str,
        fn: Callable[[], dict[str, Any]],
    ) -> dict[str, Any]:
        """Track an LLM invocation within this group."""
        start = time.monotonic()
        self.emit("llm_invocation", {"model": model, "started_at": datetime.now(timezone.utc).isoformat()})
        try:
            result = fn()
            latency = (time.monotonic() - start) * 1000
            self.emit(
                "llm_invocation",
                {
                    "model": model,
                    "response_preview": str(result.get("response", ""))[:500],
                    "tokens": result.get("tokens"),
                    "cost": result.get("cost"),
                    "completed": True,
                },
                latency_ms=latency,
            )
            return result
        except Exception as e:
            latency = (time.monotonic() - start) * 1000
            self.emit(
                "llm_invocation",
                {"model": model, "error": str(e), "completed": False},
                latency_ms=latency,
                error=True,
            )
            raise

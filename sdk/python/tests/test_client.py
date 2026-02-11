"""Tests for the Clanker Trace Python SDK client."""

import json
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler
from unittest import TestCase

from clanker_trace import ClankerTrace, ClankerTraceConfig


class FakeHandler(BaseHTTPRequestHandler):
    """Minimal HTTP handler that records requests and returns canned responses."""

    requests: list = []

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length)) if length else {}
        FakeHandler.requests.append({"method": "POST", "path": self.path, "body": body})

        if self.path == "/v1/ingest/runs":
            resp = {"id": "run-001", "status": "running", "agent_id": body.get("agent_id", "")}
        elif self.path == "/v1/ingest/events/batch":
            resp = {"inserted": len(body.get("events", [])), "events": []}
        else:
            resp = {}

        self.send_response(201)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(resp).encode())

    def do_PATCH(self):
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length)) if length else {}
        FakeHandler.requests.append({"method": "PATCH", "path": self.path, "body": body})

        resp = {"id": "run-001", "status": body.get("status", "completed")}
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(resp).encode())

    def log_message(self, format, *args):
        pass  # Suppress log output


class TestClankerTraceSDK(TestCase):
    server: HTTPServer
    server_thread: threading.Thread

    @classmethod
    def setUpClass(cls):
        FakeHandler.requests = []
        cls.server = HTTPServer(("127.0.0.1", 0), FakeHandler)
        cls.server_thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.server_thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        FakeHandler.requests.clear()
        port = self.server.server_address[1]
        self.config = ClankerTraceConfig(
            endpoint=f"http://127.0.0.1:{port}",
            api_key="ct_test_key",
            agent_id="test-agent",
            batch_size=10,
            flush_interval_s=10,  # High interval so we control flushing
        )

    def test_start_run(self):
        tracer = ClankerTrace(self.config)
        run = tracer.start_run(goal="Test task")
        tracer.shutdown()

        assert run.run_id == "run-001"
        create_req = next(r for r in FakeHandler.requests if r["path"] == "/v1/ingest/runs")
        assert create_req["body"]["agent_id"] == "test-agent"
        assert create_req["body"]["goal"] == "Test task"

    def test_emit_events(self):
        tracer = ClankerTrace(self.config)
        run = tracer.start_run()

        run.emit("step_started", {"step_name": "analyze"})
        run.emit("tool_invocation", {"tool_name": "search"}, latency_ms=150)
        run.emit("step_completed", {"step_name": "analyze"}, latency_ms=2000)

        tracer.flush()
        tracer.shutdown()

        batch_req = next(
            (r for r in FakeHandler.requests if r["path"] == "/v1/ingest/events/batch"),
            None,
        )
        assert batch_req is not None
        assert len(batch_req["body"]["events"]) == 3
        assert batch_req["body"]["events"][0]["event_type"] == "step_started"
        assert batch_req["body"]["events"][1]["latency_ms"] == 150

    def test_complete_run(self):
        tracer = ClankerTrace(self.config)
        run = tracer.start_run()
        run.complete(cost=0.01, tokens=500)
        tracer.shutdown()

        patch_req = next(r for r in FakeHandler.requests if r["method"] == "PATCH")
        assert patch_req["body"]["status"] == "completed"
        assert patch_req["body"]["total_cost"] == 0.01
        assert patch_req["body"]["total_tokens"] == 500

    def test_fail_run(self):
        tracer = ClankerTrace(self.config)
        run = tracer.start_run()
        run.fail("Tool timeout")
        tracer.shutdown()

        patch_req = next(r for r in FakeHandler.requests if r["method"] == "PATCH")
        assert patch_req["body"]["status"] == "failed"
        assert patch_req["body"]["error_message"] == "Tool timeout"

    def test_step_context_manager(self):
        tracer = ClankerTrace(self.config)
        run = tracer.start_run()

        with run.step("analyze") as step:
            step.emit("reasoning_step", {"thought": "analyzing data"})

        tracer.flush()
        tracer.shutdown()

        batch_req = next(
            (r for r in FakeHandler.requests if r["path"] == "/v1/ingest/events/batch"),
            None,
        )
        assert batch_req is not None
        events = batch_req["body"]["events"]
        assert events[0]["event_type"] == "step_started"
        assert events[1]["event_type"] == "reasoning_step"
        assert events[1].get("parent_event_id") is not None
        assert events[2]["event_type"] == "step_completed"

    def test_track_tool(self):
        tracer = ClankerTrace(self.config)
        run = tracer.start_run()

        result = run.track_tool("search", {"query": "test"}, lambda: "found it")
        assert result == "found it"

        tracer.flush()
        tracer.shutdown()

        batch_req = next(
            (r for r in FakeHandler.requests if r["path"] == "/v1/ingest/events/batch"),
            None,
        )
        assert batch_req is not None
        events = batch_req["body"]["events"]
        assert events[0]["event_type"] == "tool_invocation"
        assert events[0]["payload"]["tool_name"] == "search"
        assert events[1]["event_type"] == "tool_response"
        assert events[1]["payload"]["success"] is True

    def test_track_tool_failure(self):
        tracer = ClankerTrace(self.config)
        run = tracer.start_run()

        def failing_tool():
            raise ValueError("tool broke")

        try:
            run.track_tool("broken", {}, failing_tool)
        except ValueError:
            pass

        tracer.flush()
        tracer.shutdown()

        batch_req = next(
            (r for r in FakeHandler.requests if r["path"] == "/v1/ingest/events/batch"),
            None,
        )
        assert batch_req is not None
        events = batch_req["body"]["events"]
        assert events[1]["event_type"] == "tool_response"
        assert events[1]["payload"]["success"] is False
        assert events[1]["error_flag"] is True

    def test_cannot_emit_after_complete(self):
        tracer = ClankerTrace(self.config)
        run = tracer.start_run()
        run.complete()

        try:
            run.emit("step_started", {})
            assert False, "Should have raised"
        except RuntimeError:
            pass

        tracer.shutdown()

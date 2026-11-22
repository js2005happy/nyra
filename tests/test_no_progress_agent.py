"""Regression definitions only; not executed by automation."""
import unittest
from unittest.mock import patch
from angel.agent import Agent
from angel.no_progress import NoProgressDetector

class FakeProvider:
    def chat(self, messages, tools=None):
        return {"choices": [{"message": {"content": "done"}}]}

class AdvisoryAgentTests(unittest.TestCase):
    def test_default_disabled(self):
        agent = Agent(FakeProvider(), mode="readonly", interactive=False)
        self.assertIsNone(agent.no_progress_detector)

    def test_terminal_reply_does_not_trigger_idle_alert(self):
        events = []
        agent = Agent(FakeProvider(), mode="readonly", interactive=False,
                      no_progress_detector=NoProgressDetector(idle_limit=1),
                      on_event=lambda kind, payload: events.append((kind, payload)))
        with patch("angel.agent.save_session"):
            self.assertEqual(agent.run("task"), "done")
        alerts = [payload for kind, payload in events if kind == "no_progress_attention"]
        self.assertEqual(alerts, [])


class OneToolProvider:
    def __init__(self):
        self.calls = 0

    def chat(self, messages, tools=None):
        self.calls += 1
        if self.calls == 1:
            return {"choices": [{"message": {"content": "", "tool_calls": [{
                "id": "call-one",
                "type": "function",
                "function": {"name": "read_file", "arguments": "{}"},
            }]}}]}
        return {"choices": [{"message": {"content": "done"}}]}


class ToolObservationTests(unittest.TestCase):
    def test_one_tool_return_counts_once_not_twice(self):
        events = []
        agent = Agent(
            OneToolProvider(), mode="readonly", interactive=False,
            no_progress_detector=NoProgressDetector(idle_limit=2),
            on_event=lambda kind, payload: events.append((kind, payload)),
        )
        with patch("angel.agent.save_session"), patch(
            "angel.agent.execute_tool", return_value="ok"
        ):
            self.assertEqual(agent.run("task"), "done")
        self.assertFalse(any(kind == "no_progress_attention" for kind, _ in events))
        self.assertEqual(agent.no_progress_detector.snapshot().consecutive_idle, 1)

    def test_reused_detector_starts_each_run_with_zero_idle(self):
        events = []
        detector = NoProgressDetector(idle_limit=2)
        detector.observe_event("tool_returned")
        self.assertEqual(detector.snapshot().consecutive_idle, 1)
        agent = Agent(
            OneToolProvider(), mode="readonly", interactive=False,
            no_progress_detector=detector,
            on_event=lambda kind, payload: events.append((kind, payload)),
        )
        with patch("angel.agent.save_session"), patch(
            "angel.agent.execute_tool", return_value="ok"
        ):
            self.assertEqual(agent.run("new task"), "done")
        self.assertEqual(detector.snapshot().consecutive_idle, 1)
        self.assertFalse(any(kind == "no_progress_attention" for kind, _ in events))

    def test_one_tool_return_alerts_at_limit_one(self):
        events = []
        agent = Agent(
            OneToolProvider(), mode="readonly", interactive=False,
            no_progress_detector=NoProgressDetector(idle_limit=1),
            on_event=lambda kind, payload: events.append((kind, payload)),
        )
        with patch("angel.agent.save_session"), patch(
            "angel.agent.execute_tool", return_value="ok"
        ):
            self.assertEqual(agent.run("task"), "done")
        alerts = [payload for kind, payload in events if kind == "no_progress_attention"]
        self.assertEqual(len(alerts), 1)
        self.assertEqual(alerts[0]["consecutive_idle"], 1)
        self.assertFalse(alerts[0]["execution_verified"])
        self.assertFalse(alerts[0]["safe_to_auto_resume"])


    def test_failed_tool_report_remains_idle_and_does_not_grant_authority(self):
        events = []
        detector = NoProgressDetector(idle_limit=1)
        agent = Agent(
            OneToolProvider(), mode="readonly", interactive=False,
            no_progress_detector=detector,
            on_event=lambda kind, payload: events.append((kind, payload)),
        )
        with patch("angel.agent.save_session"), patch(
            "angel.agent.execute_tool", return_value="执行失败：simulated"
        ):
            self.assertEqual(agent.run("task"), "done")
        self.assertTrue(detector.snapshot().needs_attention)
        self.assertEqual(detector.snapshot().consecutive_idle, 1)
        alerts = [payload for kind, payload in events if kind == "no_progress_attention"]
        self.assertEqual(len(alerts), 1)
        self.assertFalse(alerts[0]["execution_verified"])
        self.assertFalse(alerts[0]["safe_to_auto_resume"])

if __name__ == "__main__":
    unittest.main()

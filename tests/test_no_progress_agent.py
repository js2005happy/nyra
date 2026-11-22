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

if __name__ == "__main__":
    unittest.main()

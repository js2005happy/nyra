"""Regression definitions only; not executed by the development automation."""
import unittest

from angel.no_progress import NoProgressDetector, ProgressSignalError


class NoProgressDetectorTests(unittest.TestCase):
    def test_idle_threshold_and_saturation(self):
        detector = NoProgressDetector(idle_limit=2)
        self.assertFalse(detector.observe(progress=False).needs_attention)
        self.assertTrue(detector.observe(progress=False).needs_attention)
        self.assertEqual(detector.observe(progress=False).consecutive_idle, 2)

    def test_explicit_progress_resets(self):
        detector = NoProgressDetector(idle_limit=1)
        detector.observe(progress=False)
        state = detector.observe(progress=True)
        self.assertEqual(state.consecutive_idle, 0)
        self.assertFalse(state.needs_attention)

    def test_never_grants_execution_authority(self):
        state = NoProgressDetector(idle_limit=1).observe(progress=False)
        self.assertFalse(state.execution_verified)
        self.assertFalse(state.safe_to_auto_resume)

    def test_invalid_limits_and_signals(self):
        for limit in (0, -1, 1001, True, 2.5):
            with self.assertRaises(ProgressSignalError):
                NoProgressDetector(limit)
        with self.assertRaises(ProgressSignalError):
            NoProgressDetector().observe(progress=1)

    def test_poll_and_model_text_never_reset_idle(self):
        detector = NoProgressDetector(idle_limit=2)
        detector.observe_event("status_poll")
        self.assertTrue(detector.observe_event("model_message").needs_attention)
        self.assertTrue(detector.observe_event("tool_returned").needs_attention)

    def test_attested_deliverable_only_resets_with_explicit_trust(self):
        detector = NoProgressDetector(idle_limit=1)
        detector.observe_event("deliverable_committed")
        self.assertTrue(detector.snapshot().needs_attention)
        state = detector.observe_event("deliverable_committed", trusted=True)
        self.assertFalse(state.needs_attention)
        self.assertFalse(state.execution_verified)
        self.assertFalse(state.safe_to_auto_resume)

    def test_unknown_or_forged_event_rejected_without_mutation(self):
        detector = NoProgressDetector(idle_limit=1)
        detector.observe_event("status_poll")
        for event, trusted in (("success", False), ("model_message", True),
                               ("acceptance_confirmed", 1), (None, False)):
            with self.assertRaises(ProgressSignalError):
                detector.observe_event(event, trusted=trusted)
            self.assertEqual(detector.snapshot().consecutive_idle, 1)

    def test_observation_does_not_store_content(self):
        detector = NoProgressDetector()
        self.assertEqual(set(vars(detector)), {"_limit", "_idle"})


if __name__ == "__main__":
    unittest.main()

"""Static regression definitions for conservative legacy tool result classification.

Not executed by the scheduled development automation.
"""
import unittest

from angel.tool_report_status import classify_tool_report, StructuredToolReport


class ToolReportStatusTests(unittest.TestCase):
    def test_both_legacy_error_prefixes_are_failures(self):
        for text in ("错误：denied", "执行失败：timeout"):
            with self.subTest(text=text):
                status = classify_tool_report(text)
                self.assertTrue(status.reported_failure)
                self.assertFalse(status.execution_verified)
                self.assertFalse(status.safe_to_auto_resume)

    def test_success_looking_text_is_never_verified(self):
        for result in ("ok", "success", {"ok": True}, None):
            with self.subTest(result=result):
                status = classify_tool_report(result)
                self.assertFalse(status.reported_failure)
                self.assertFalse(status.execution_verified)
                self.assertFalse(status.safe_to_auto_resume)

    def test_untyped_non_text_reports_are_unknown(self):
        for result in ({"ok": True}, {"outcome": "reported_ok"}, None, 0, False, []):
            with self.subTest(result=result):
                status = classify_tool_report(result)
                self.assertFalse(status.reported_failure)
                self.assertTrue(status.reported_unknown)
                self.assertFalse(status.execution_verified)
                self.assertFalse(status.safe_to_auto_resume)

    def test_blank_legacy_report_is_unknown(self):
        for result in ("", " ", "\n\t", "\u2003"):
            with self.subTest(result=result):
                status = classify_tool_report(result)
                self.assertFalse(status.reported_failure)
                self.assertTrue(status.reported_unknown)
                self.assertFalse(status.execution_verified)
                self.assertFalse(status.safe_to_auto_resume)

    def test_blank_report_with_exception_is_failure(self):
        status = classify_tool_report("  ", raised=True)
        self.assertTrue(status.reported_failure)
        self.assertFalse(status.reported_unknown)

    def test_raised_non_text_is_failure_not_unknown(self):
        status = classify_tool_report(None, raised=True)
        self.assertTrue(status.reported_failure)
        self.assertFalse(status.reported_unknown)

    def test_exception_overrides_success_looking_result(self):
        self.assertTrue(classify_tool_report("ok", raised=True).reported_failure)

    def test_structured_failure_is_not_overridden_by_success_looking_text(self):
        for outcome, failed in (
            ("reported_ok", False),
            ("reported_error", True),
            ("unknown", False),
        ):
            with self.subTest(outcome=outcome):
                status = classify_tool_report(StructuredToolReport(outcome))
                self.assertEqual(status.reported_failure, failed)
                self.assertEqual(status.reported_unknown, outcome == "unknown")
                self.assertFalse(status.execution_verified)
                self.assertFalse(status.safe_to_auto_resume)

    def test_structured_exception_overrides_report(self):
        status = classify_tool_report(StructuredToolReport("reported_ok"), raised=True)
        self.assertTrue(status.reported_failure)
        self.assertFalse(status.reported_unknown)
        self.assertFalse(status.safe_to_auto_resume)

    def test_structured_invalid_outcome_rejected(self):
        for outcome in ("success", "", None, True, 1):
            with self.subTest(outcome=outcome):
                with self.assertRaises(ValueError):
                    StructuredToolReport(outcome)

    def test_untrusted_dict_is_not_a_structured_report(self):
        status = classify_tool_report({"outcome": "reported_error"})
        self.assertFalse(status.reported_failure)
        self.assertFalse(status.execution_verified)

    def test_invalid_exception_flag_rejected(self):
        for flag in (1, None, "true"):
            with self.subTest(flag=flag):
                with self.assertRaises(ValueError):
                    classify_tool_report("ok", raised=flag)


if __name__ == "__main__":
    unittest.main()

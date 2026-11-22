"""Static regression definitions for conservative legacy tool result classification.

Not executed by the scheduled development automation.
"""
import unittest

from angel.tool_report_status import classify_tool_report


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

    def test_exception_overrides_success_looking_result(self):
        self.assertTrue(classify_tool_report("ok", raised=True).reported_failure)

    def test_invalid_exception_flag_rejected(self):
        for flag in (1, None, "true"):
            with self.subTest(flag=flag):
                with self.assertRaises(ValueError):
                    classify_tool_report("ok", raised=flag)


if __name__ == "__main__":
    unittest.main()

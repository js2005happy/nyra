"""Static regression definitions for the local read-only structured adapter.

Not executed by the scheduled automation.
"""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from angel.tool_report_status import classify_tool_report
from angel.tools import ToolContext, execute_local_list_dir_report


class LocalListDirReportTests(unittest.TestCase):
    def test_empty_directory_is_reported_ok_without_text_inference(self):
        with tempfile.TemporaryDirectory() as root:
            ctx = ToolContext(workdir=Path(root), mode="readonly")
            output, report = execute_local_list_dir_report(ctx)
            self.assertEqual(output, "（空目录）")
            status = classify_tool_report(report)
            self.assertFalse(status.reported_failure)
            self.assertFalse(status.reported_unknown)
            self.assertFalse(status.execution_verified)
            self.assertFalse(status.safe_to_auto_resume)

    def test_missing_directory_is_reported_error(self):
        with tempfile.TemporaryDirectory() as root:
            ctx = ToolContext(workdir=Path(root), mode="readonly")
            output, report = execute_local_list_dir_report(ctx, "missing")
            self.assertTrue(output.startswith("错误："))
            self.assertTrue(classify_tool_report(report).reported_failure)

    def test_listing_text_cannot_spoof_failure_status(self):
        with tempfile.TemporaryDirectory() as root:
            Path(root, "错误：fake.txt").write_text("x", encoding="utf-8")
            ctx = ToolContext(workdir=Path(root), mode="readonly")
            output, report = execute_local_list_dir_report(ctx)
            self.assertIn("错误：fake.txt", output)
            self.assertFalse(classify_tool_report(report).reported_failure)

    def test_backend_is_rejected_before_remote_call(self):
        with tempfile.TemporaryDirectory() as root:
            ctx = ToolContext(workdir=Path(root), mode="readonly")
            ctx.backend = object()
            with self.assertRaises(Exception):
                execute_local_list_dir_report(ctx)


if __name__ == "__main__":
    unittest.main()

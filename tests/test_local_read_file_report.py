"""Regression definitions for local read_file structured outcome (not executed)."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from angel.tool_report_status import classify_tool_report
from angel.tools import ToolContext, execute_local_read_file_report


class LocalReadFileReportTests(unittest.TestCase):
    def _ctx(self, root):
        return ToolContext(workdir=Path(root), mode="readonly", interactive=False,
                           memory_path=Path(root) / "MEMORY.md", skills_dir=Path(root) / "skills")

    def test_error_prefix_in_file_is_data_not_failed_read(self):
        with tempfile.TemporaryDirectory() as root:
            Path(root, "note.txt").write_text("错误：this is ordinary file data", encoding="utf-8")
            output, report = execute_local_read_file_report(self._ctx(root), "note.txt")
            self.assertTrue(output.startswith("错误："))
            status = classify_tool_report(report)
            self.assertFalse(status.reported_failure)
            self.assertFalse(status.reported_unknown)
            self.assertFalse(status.execution_verified)
            self.assertFalse(status.safe_to_auto_resume)

    def test_empty_file_is_reported_ok_not_unknown(self):
        with tempfile.TemporaryDirectory() as root:
            Path(root, "empty.txt").write_text("", encoding="utf-8")
            output, report = execute_local_read_file_report(self._ctx(root), "empty.txt")
            self.assertEqual(output, "")
            self.assertFalse(classify_tool_report(report).reported_unknown)

    def test_missing_file_is_error(self):
        with tempfile.TemporaryDirectory() as root:
            output, report = execute_local_read_file_report(self._ctx(root), "missing.txt")
            self.assertTrue(output.startswith("错误："))
            self.assertTrue(classify_tool_report(report).reported_failure)

    def test_os_error_redacts_private_path(self):
        with tempfile.TemporaryDirectory() as root:
            secret = "/private/credentials/file"
            with patch("angel.tools._resolve_path", side_effect=OSError(secret)):
                output, report = execute_local_read_file_report(self._ctx(root), "note.txt")
            self.assertEqual(output, "执行失败：文件读取失败")
            self.assertNotIn(secret, output)
            self.assertTrue(classify_tool_report(report).reported_failure)

    def test_type_error_redacts_private_path(self):
        with tempfile.TemporaryDirectory() as root:
            with patch("angel.tools._resolve_path", side_effect=TypeError("secret argument")):
                output, report = execute_local_read_file_report(self._ctx(root), "note.txt")
            self.assertEqual(output, "错误：工具参数不正确")
            self.assertTrue(classify_tool_report(report).reported_failure)

    def test_remote_backend_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            ctx = self._ctx(root)
            ctx.backend = object()
            with self.assertRaises(Exception):
                execute_local_read_file_report(ctx, "note.txt")


if __name__ == "__main__":
    unittest.main()

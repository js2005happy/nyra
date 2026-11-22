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
            ctx = ToolContext(workdir=Path(root), mode="readonly", interactive=False, memory_path=Path(root) / "MEMORY.md", skills_dir=Path(root) / "skills")
            output, report = execute_local_list_dir_report(ctx)
            self.assertEqual(output, "（空目录）")
            status = classify_tool_report(report)
            self.assertFalse(status.reported_failure)
            self.assertFalse(status.reported_unknown)
            self.assertFalse(status.execution_verified)
            self.assertFalse(status.safe_to_auto_resume)

    def test_missing_directory_is_reported_error(self):
        with tempfile.TemporaryDirectory() as root:
            ctx = ToolContext(workdir=Path(root), mode="readonly", interactive=False, memory_path=Path(root) / "MEMORY.md", skills_dir=Path(root) / "skills")
            output, report = execute_local_list_dir_report(ctx, "missing")
            self.assertTrue(output.startswith("错误："))
            self.assertTrue(classify_tool_report(report).reported_failure)

    def test_missing_directory_does_not_echo_private_path(self):
        with tempfile.TemporaryDirectory() as root:
            ctx = ToolContext(workdir=Path(root), mode="readonly", interactive=False, memory_path=Path(root) / "MEMORY.md", skills_dir=Path(root) / "skills")
            secret = "/private/customer-identifier/hidden-folder"
            output, report = execute_local_list_dir_report(ctx, secret)
            self.assertEqual(output, "错误：目录不存在")
            self.assertNotIn(secret, output)
            status = classify_tool_report(report)
            self.assertTrue(status.reported_failure)
            self.assertFalse(status.execution_verified)
            self.assertFalse(status.safe_to_auto_resume)

    def test_listing_text_cannot_spoof_failure_status(self):
        with tempfile.TemporaryDirectory() as root:
            Path(root, "错误：fake.txt").write_text("x", encoding="utf-8")
            ctx = ToolContext(workdir=Path(root), mode="readonly", interactive=False, memory_path=Path(root) / "MEMORY.md", skills_dir=Path(root) / "skills")
            output, report = execute_local_list_dir_report(ctx)
            self.assertIn("错误：fake.txt", output)
            self.assertFalse(classify_tool_report(report).reported_failure)

    def test_os_error_does_not_expose_private_path(self):
        with tempfile.TemporaryDirectory() as root:
            ctx = ToolContext(workdir=Path(root), mode="readonly", interactive=False, memory_path=Path(root) / "MEMORY.md", skills_dir=Path(root) / "skills")
            secret = "/private/account-token/hidden-folder"
            with patch("angel.tools._resolve_path", side_effect=OSError(f"permission denied: {secret}")):
                output, report = execute_local_list_dir_report(ctx)
            self.assertEqual(output, "执行失败：目录读取失败")
            self.assertNotIn(secret, output)
            status = classify_tool_report(report)
            self.assertTrue(status.reported_failure)
            self.assertFalse(status.execution_verified)
            self.assertFalse(status.safe_to_auto_resume)

    def test_type_error_redacts_private_path(self):
        with tempfile.TemporaryDirectory() as root:
            ctx = ToolContext(workdir=Path(root), mode="readonly", interactive=False, memory_path=Path(root) / "MEMORY.md", skills_dir=Path(root) / "skills")
            secret = "/private/session-key/location"
            with patch("angel.tools._resolve_path", side_effect=TypeError(f"bad argument: {secret}")):
                output, report = execute_local_list_dir_report(ctx)
            self.assertEqual(output, "错误：工具参数不正确")
            self.assertNotIn(secret, output)
            self.assertTrue(classify_tool_report(report).reported_failure)

    def test_backend_is_rejected_before_remote_call(self):
        with tempfile.TemporaryDirectory() as root:
            ctx = ToolContext(workdir=Path(root), mode="readonly", interactive=False, memory_path=Path(root) / "MEMORY.md", skills_dir=Path(root) / "skills")
            ctx.backend = object()
            with self.assertRaises(Exception):
                execute_local_list_dir_report(ctx)


if __name__ == "__main__":
    unittest.main()

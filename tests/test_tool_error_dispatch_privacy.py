"""Static regression definitions for ToolError privacy at generic dispatch.

These tests intentionally do not execute as part of this change.
"""
import unittest
from pathlib import Path
from unittest.mock import patch

from angel.tools import ToolContext, ToolError, execute_tool


class ToolErrorDispatchPrivacyTests(unittest.TestCase):
    def setUp(self):
        self.ctx = ToolContext(
            workdir=Path("."), mode="readonly", interactive=False,
            memory_path=Path("MEMORY.md"), skills_dir=Path("skills"),
        )

    def test_explicit_tool_error_never_echoes_private_path_or_token(self):
        private = "/home/example/private/token=secret-DO-NOT-LOG"
        with patch("angel.tools._tool_git_status", side_effect=ToolError(private)):
            result = execute_tool("git_status", {"path": "."}, self.ctx)
        self.assertEqual(result, "错误：工具执行被拒绝或失败")
        self.assertNotIn(private, result)

    def test_explicit_tool_error_keeps_failure_prefix(self):
        with patch("angel.tools._tool_git_status", side_effect=ToolError("用户拒绝执行")):
            result = execute_tool("git_status", {"path": "."}, self.ctx)
        self.assertTrue(result.startswith("错误："))

    def test_unrelated_type_error_remains_generic(self):
        result = execute_tool("git_status", {"unexpected_argument": "private"}, self.ctx)
        self.assertEqual(result, "错误：工具参数不正确")


if __name__ == "__main__":
    unittest.main()

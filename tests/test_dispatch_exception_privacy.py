"""Static regression definitions for dispatch exception privacy (not executed)."""
import unittest
from pathlib import Path
from unittest.mock import patch

from angel.tools import ToolContext, ToolError, execute_tool


class DispatchExceptionPrivacyTests(unittest.TestCase):
    def setUp(self):
        self.ctx = ToolContext(
            workdir=Path("."), mode="readonly", interactive=False,
            memory_path=Path("MEMORY.md"), skills_dir=Path("skills"),
        )

    def test_argument_error_does_not_echo_private_value(self):
        secret = "/home/private-user/.secrets/api-key"
        with patch("angel.tools._tool_read_file", side_effect=TypeError(secret)):
            result = execute_tool("read_file", {"path": "a"}, self.ctx)
        self.assertEqual(result, "错误：工具参数不正确")
        self.assertNotIn(secret, result)

    def test_unexpected_error_does_not_echo_private_value(self):
        secret = "token=private-example-value"
        with patch("angel.tools._tool_read_file", side_effect=RuntimeError(secret)):
            result = execute_tool("read_file", {"path": "a"}, self.ctx)
        self.assertEqual(result, "执行失败：工具执行失败")
        self.assertNotIn(secret, result)

    def test_explicit_tool_error_preserves_existing_contract(self):
        with patch("angel.tools._tool_read_file", side_effect=ToolError("permission denied")):
            result = execute_tool("read_file", {"path": "a"}, self.ctx)
        self.assertEqual(result, "错误：permission denied")


if __name__ == "__main__":
    unittest.main()

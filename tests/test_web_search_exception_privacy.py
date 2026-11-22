"""Static regression definitions for web search exception privacy; not executed."""
import unittest
from pathlib import Path
from unittest.mock import patch

from angel.tools import ToolContext, ToolError, _tool_web_search


class WebSearchExceptionPrivacyTests(unittest.TestCase):
    def setUp(self):
        self.ctx = ToolContext(
            workdir=Path("."), mode="readonly", interactive=False,
            memory_path=Path("MEMORY.md"), skills_dir=Path("skills"),
        )

    def test_tool_error_does_not_echo_private_query_or_token(self):
        private = "private-query-DO-NOT-LOG"
        with patch("angel.tools._fetch_search_page", side_effect=ToolError(private)):
            output = _tool_web_search(self.ctx, private)
        self.assertIn("错误：搜索失败", output)
        self.assertNotIn(private, output)
        self.assertIn("Bing", output)
        self.assertIn("百度", output)

    def test_unexpected_network_exception_does_not_echo_secret(self):
        private = "private-credential-DO-NOT-LOG"
        with patch("angel.tools._fetch_search_page", side_effect=OSError(private)):
            output = _tool_web_search(self.ctx, "ordinary query")
        self.assertIn("请求失败", output)
        self.assertNotIn(private, output)

    def test_fallback_success_preserves_result(self):
        with patch("angel.tools._fetch_search_page", side_effect=[ToolError("private"), "<html>ok</html>"]), \
             patch("angel.tools._parse_baidu_html", return_value=["1. Public result"]):
            output = _tool_web_search(self.ctx, "public query")
        self.assertEqual(output, "1. Public result")


if __name__ == "__main__":
    unittest.main()

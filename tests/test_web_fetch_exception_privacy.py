"""Regression definitions for web_fetch exception privacy; not executed."""
import unittest
from pathlib import Path
from unittest.mock import patch

from angel.tools import ToolContext, _tool_web_fetch


class WebFetchExceptionPrivacyTests(unittest.TestCase):
    def setUp(self):
        self.ctx = ToolContext(
            workdir=Path("."), mode="readonly", interactive=False,
            memory_path=Path("MEMORY.md"), skills_dir=Path("skills"),
        )

    def test_network_exception_does_not_echo_private_url_or_token(self):
        secret = "private-token-DO-NOT-LOG"
        with patch("angel.tools.open_url", side_effect=OSError(secret)):
            result = _tool_web_fetch(self.ctx, "https://example.invalid/private")
        self.assertEqual(result, "错误：抓取失败")
        self.assertNotIn(secret, result)

    def test_successful_fetch_preserves_content(self):
        from unittest.mock import MagicMock
        response = MagicMock()
        response.headers.get_content_charset.return_value = "utf-8"
        response.read.return_value = b"<p>Public text</p>"
        manager = MagicMock()
        manager.__enter__.return_value = response
        with patch("angel.tools.open_url", return_value=manager):
            result = _tool_web_fetch(self.ctx, "https://example.org/")
        self.assertEqual(result, "Public text")


if __name__ == "__main__":
    unittest.main()

"""Regression definitions for http_post exception privacy; not executed."""
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from angel.tools import ToolContext, _tool_http_post


class HttpPostExceptionPrivacyTests(unittest.TestCase):
    def setUp(self):
        self.ctx = ToolContext(
            workdir=Path("."), mode="full", interactive=False,
            memory_path=Path("MEMORY.md"), skills_dir=Path("skills"),
        )

    def test_network_exception_hides_private_url_and_token(self):
        secret = "private-post-token-DO-NOT-LOG"
        with patch("angel.tools.open_url", side_effect=OSError(secret)):
            output = _tool_http_post(
                self.ctx, "https://example.invalid/submit?token=" + secret,
                body='{"value":"example"}',
            )
        self.assertEqual(output, "错误：POST 请求失败")
        self.assertNotIn(secret, output)

    def test_successful_response_preserves_status_and_body(self):
        response = MagicMock()
        response.status = 201
        response.headers.get_content_charset.return_value = "utf-8"
        response.read.return_value = b'{"ok":true}'
        manager = MagicMock()
        manager.__enter__.return_value = response
        with patch("angel.tools.open_url", return_value=manager):
            output = _tool_http_post(self.ctx, "https://example.org/submit")
        self.assertEqual(output, 'HTTP 201\n{"ok":true}')


if __name__ == "__main__":
    unittest.main()

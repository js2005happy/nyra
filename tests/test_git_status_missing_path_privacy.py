"""Static regression definitions for local git_status missing-path privacy."""

import tempfile
import unittest
from pathlib import Path

from angel.tools import ToolContext, execute_tool


class GitStatusMissingPathPrivacyTests(unittest.TestCase):
    def test_missing_absolute_directory_does_not_echo_private_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            secret = root / "private-token-DO-NOT-EXPOSE"
            ctx = ToolContext(
                workdir=root,
                mode="readonly",
                interactive=False,
                memory_path=root / "memory.md",
                skills_dir=root / "skills",
            )
            output = execute_tool("git_status", {"path": str(secret)}, ctx)
            self.assertEqual(output, "错误：目录不存在")
            self.assertNotIn("private-token-DO-NOT-EXPOSE", output)


if __name__ == "__main__":
    unittest.main()

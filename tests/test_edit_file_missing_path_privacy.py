"""Unexecuted regression definitions for missing local edit_file path privacy."""

import tempfile
import unittest
from pathlib import Path

from angel.tools import ToolContext, execute_tool


class EditFileMissingPathPrivacyTests(unittest.TestCase):
    def test_missing_file_does_not_echo_private_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            private = root / "private-token-DO-NOT-EXPOSE.txt"
            ctx = ToolContext(
                workdir=root,
                mode="full",
                interactive=False,
                memory_path=root / "memory.md",
                skills_dir=root / "skills",
            )
            output = execute_tool(
                "edit_file",
                {"path": str(private), "old_text": "old", "new_text": "new"},
                ctx,
            )
            self.assertEqual(output, "错误：文件不存在")
            self.assertNotIn("private-token-DO-NOT-EXPOSE", output)
            self.assertFalse(private.exists())


if __name__ == "__main__":
    unittest.main()

"""Unexecuted regression definitions for local git diff failure reporting."""

import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from angel.tools import ToolContext, execute_tool


class GitStatusDiffFailureTests(unittest.TestCase):
    def test_nonzero_diff_does_not_return_partial_success_or_stderr(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            ctx = ToolContext(
                workdir=root, mode="readonly", interactive=False,
                memory_path=root / "memory.md", skills_dir=root / "skills",
            )
            status = subprocess.CompletedProcess(
                args=["git", "status"], returncode=0,
                stdout="## main\n M file.py\n", stderr="",
            )
            diff = subprocess.CompletedProcess(
                args=["git", "diff"], returncode=128,
                stdout="", stderr="fatal: private-token-DO-NOT-EXPOSE",
            )
            with patch("angel.tools.subprocess.run", side_effect=[status, diff]) as run:
                output = execute_tool("git_status", {"path": "."}, ctx)
            self.assertEqual(output, "错误：git diff 失败（状态快照不完整）")
            self.assertNotIn("private-token-DO-NOT-EXPOSE", output)
            self.assertEqual(run.call_count, 2)

    def test_zero_diff_keeps_existing_status_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            ctx = ToolContext(
                workdir=root, mode="readonly", interactive=False,
                memory_path=root / "memory.md", skills_dir=root / "skills",
            )
            status = subprocess.CompletedProcess(
                args=["git", "status"], returncode=0,
                stdout="## main\n M file.py\n", stderr="",
            )
            diff = subprocess.CompletedProcess(
                args=["git", "diff"], returncode=0,
                stdout=" file.py | 1 +\n", stderr="",
            )
            with patch("angel.tools.subprocess.run", side_effect=[status, diff]):
                output = execute_tool("git_status", {"path": "."}, ctx)
            self.assertIn("## main", output)
            self.assertIn("改动统计", output)


if __name__ == "__main__":
    unittest.main()

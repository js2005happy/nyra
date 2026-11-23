"""Static regression definitions for grep_search missing-path privacy."""

from pathlib import Path
from unittest.mock import Mock

from angel.tools import ToolContext, _tool_grep_search


def _context(tmp_path: Path, backend=None) -> ToolContext:
    return ToolContext(
        workdir=tmp_path,
        mode="readonly",
        interactive=False,
        memory_path=tmp_path / "memory.md",
        skills_dir=tmp_path / "skills",
        backend=backend,
    )


def test_local_missing_path_does_not_echo_private_path(tmp_path: Path) -> None:
    secret_path = str(tmp_path / "private-user-token-123" / "missing")
    result = _tool_grep_search(_context(tmp_path), "needle", path=secret_path)
    assert result == "错误：路径不存在"
    assert secret_path not in result


def test_backend_missing_path_does_not_echo_private_path(tmp_path: Path) -> None:
    backend = Mock()
    backend.run_command.return_value = "grep: No such file or directory"
    secret_path = "private-user-token-123/missing"
    result = _tool_grep_search(_context(tmp_path, backend), "needle", path=secret_path)
    assert result == "错误：路径不存在"
    assert secret_path not in result

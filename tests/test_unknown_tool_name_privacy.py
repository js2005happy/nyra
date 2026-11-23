"""Static regression definitions for unknown tool name privacy.

These tests intentionally require no network or external accounts.
"""
from pathlib import Path

from angel.tools import ToolContext, execute_tool


def test_unknown_tool_does_not_echo_private_name(tmp_path: Path) -> None:
    ctx = ToolContext(workdir=tmp_path, mode="readonly", interactive=False)
    private_name = "missing_tool_TOKEN=private-example-value"
    result = execute_tool(private_name, {}, ctx)
    assert result == "错误：未知工具"
    assert private_name not in result
    assert "private-example-value" not in result


def test_unknown_tool_does_not_echo_private_path(tmp_path: Path) -> None:
    ctx = ToolContext(workdir=tmp_path, mode="readonly", interactive=False)
    result = execute_tool("/private/example/secret-tool", {}, ctx)
    assert result == "错误：未知工具"
    assert "/private/example" not in result

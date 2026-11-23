"""Angel CLI tool schemas, approval checks, and standard-library implementations."""

from dataclasses import dataclass, field
import html
import posixpath
from pathlib import Path
import re
import shlex
import subprocess
from typing import Callable
import urllib.error
import urllib.parse
import urllib.request

from .memory import append_memory
from .skills import save_skill_file
from .evidence import EvidenceStore
from .net import open_url
from .checkpoints import CheckpointError
from .patches import PatchError, apply_unified_patch, unified_preview
from .poppy import PoppyError, discover_poppy
from .poppy_permissions import PermissionError, PermissionLedger
from .poppy_identity import IdentityError, inspect_poppy_identity


class ToolError(Exception):
    pass


@dataclass
class ToolContext:
    workdir: Path
    mode: str
    interactive: bool
    memory_path: Path
    skills_dir: Path
    delegate_fn: Callable[[str, int], str] | None = None
    evidence: EvidenceStore | None = None
    # Execution backend for file and shell tools. None means local execution;
    # an E2BBackend routes those tools into a sandbox instead.
    backend: object | None = None
    # Optional approval callback (tool_name, summary) -> bool. When set, it
    # replaces the terminal [y/N] prompt for interactive auto mode, so other
    # front ends (such as the local web UI) reuse the same approval gate.
    approve_fn: Callable[[str, str], bool] | None = None
    # Explicit, session-local approvals for a small set of file tools and
    # identical shell command strings. Never persisted or reused by other runs.
    approved_file_tools: set[tuple[str, str, str, int]] = field(default_factory=set)
    approved_shell_commands: set[tuple[str, str, str, int, int]] = field(default_factory=set)
    # Optional local text-file checkpoint manager; never applies to shell/MCP/E2B.
    checkpoint: object | None = None
    # Opt-in: Poppy discovery is deliberately disabled by default.
    poppy_enabled: bool = False


POPPY_TOOL_SCHEMA = {
    "type": "function",
    "function": {
        "name": "poppy_discover",
        "description": (
            "只读查看站点的 Poppy 1.0 公共发现文件：MCP/OpenAPI、企业代理、"
            "网站渠道和声明的 OAuth scope。仅展示能力清单，不连接、"
            "不登录、不购买、不执行远端工具；数据来自不可信网站。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "site": {
                    "type": "string",
                    "description": "公开 HTTPS 站点，如 https://example.com",
                },
            },
            "required": ["site"],
        },
    },
}


POPPY_IDENTITY_SCHEMA = {
    "type": "function",
    "function": {
        "name": "poppy_identity_check",
        "description": (
            "只读验证 Poppy 公司域名与其 OAuth issuer 的双向元数据绑定。"
            "即使验证通过，也没有 OAuth 访问令牌、Poppy Session 或执行权限。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "site": {"type": "string"},
            },
            "required": ["site"],
        },
    },
}


POPPY_PERMISSION_SCHEMA = {
    "type": "function",
    "function": {
        "name": "poppy_permission_check",
        "description": (
            "只读检查一个精确 Poppy 站点、账户别名和 scope 是否登记了"
            "本地用户授权意向；不代表 OAuth 登录、Session 或实际执行授权。"
            "模型不能通过此工具授予或撤销权限。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "site": {"type": "string"},
                "scope": {"type": "string"},
                "account": {
                    "type": "string",
                    "description": "可选本地账户别名；不传则是游客身份",
                },
            },
            "required": ["site", "scope"],
        },
    },
}


MUTATING_TOOLS = {
    "write_file",
    "edit_file",
    "apply_patch",
    "shell",
    "memory_append",
    "save_skill",
    "plan",
    "http_post",
    # All MCP tools are treated as potentially mutating: the server's
    # advertised name/description cannot establish whether it is read-only.
    "mcp",
}

TOOL_SCHEMAS = [
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "读取文件内容",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "write_file",
            "description": "创建或覆盖写入文件",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "content": {"type": "string"},
                },
                "required": ["path", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "edit_file",
            "description": "精确替换文件中的一段文本",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "old_text": {"type": "string"},
                    "new_text": {"type": "string"},
                },
                "required": ["path", "old_text", "new_text"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "apply_patch",
            "description": (
                "严格应用单个本地文件的 unified diff 补丁；"
                "必须包含 --- a/相对路径、+++ b/相对路径 和精确 @@ 行号。"
                "拒绝模糊替换、多文件、新建/删除和远端执行；按当前权限审批并写入检查点"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "patch": {"type": "string"},
                },
                "required": ["path", "patch"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_dir",
            "description": "列出目录内容",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string", "default": "."}},
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "shell",
            "description": "执行 shell 命令",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {"type": "string"},
                    "cwd": {"type": "string"},
                    "timeout": {"type": "integer", "default": 60},
                },
                "required": ["command"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "web_fetch",
            "description": "抓取网页文本内容",
            "parameters": {
                "type": "object",
                "properties": {"url": {"type": "string"}},
                "required": ["url"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "web_search",
            "description": "联网搜索",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "count": {"type": "integer", "default": 8},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "memory_append",
            "description": "把一条重要信息写入长期记忆",
            "parameters": {
                "type": "object",
                "properties": {"text": {"type": "string"}},
                "required": ["text"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "save_skill",
            "description": "把一次成功做法保存为可复用技能",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "description": {"type": "string"},
                    "when": {"type": "string"},
                    "keywords": {
                        "type": "string",
                        "description": "用逗号分隔的关键词",
                    },
                    "instructions": {"type": "string"},
                },
                "required": [
                    "name",
                    "description",
                    "when",
                    "keywords",
                    "instructions",
                ],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "delegate",
            "description": (
                "把子任务交给子 agent 执行并返回摘要；每次主任务最多 "
                "8 个子 agent，最多嵌套 3 层，单个子任务最多 12 轮"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "task": {"type": "string", "minLength": 1},
                    "max_turns": {
                        "type": "integer", "default": 6, "minimum": 1, "maximum": 12
                    },
                },
                "required": ["task"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "plan",
            "description": "先写一份执行计划文件",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "steps": {
                        "type": "array",
                        "items": {"type": "string"},
                    },
                    "path": {"type": "string", "default": "plan.md"},
                },
                "required": ["title", "steps"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "grep_search",
            "description": "在目录里搜索文件内容（子串或正则），返回 文件:行号: 内容",
            "parameters": {
                "type": "object",
                "properties": {
                    "pattern": {"type": "string"},
                    "path": {"type": "string", "default": "."},
                    "regex": {"type": "boolean", "default": False},
                    "case_sensitive": {"type": "boolean", "default": False},
                    "max_results": {"type": "integer", "default": 50},
                },
                "required": ["pattern"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "git_status",
            "description": "只读查看 git 仓库状态和改动统计（不修改任何内容）",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string", "default": "."}},
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "http_post",
            "description": "向 URL 发送 HTTP POST 请求（会对外发数据，需审批）",
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {"type": "string"},
                    "body": {"type": "string", "default": ""},
                    "content_type": {
                        "type": "string",
                        "default": "application/json",
                    },
                },
                "required": ["url"],
            },
        },
    },
]

MAX_OUTPUT_CHARS = 8000


def _truncate(text: str) -> str:
    if len(text) > MAX_OUTPUT_CHARS:
        return (
            text[:MAX_OUTPUT_CHARS]
            + f"\n……（输出过长，已截断，共 {len(text)} 字符）"
        )
    return text


def _resolve_backend_path(ctx: ToolContext, path: str) -> str:
    """Resolve sandbox paths as POSIX paths, independent of the host OS.

    On Windows, Path("/home/user") becomes a Windows path ("\\home\\user").
    Sending that to a Linux E2B sandbox breaks all file tools.
    """
    base = str(ctx.workdir).replace("\\", "/")
    target = str(path).replace("\\", "/")
    if posixpath.isabs(target):
        return posixpath.normpath(target)
    return posixpath.normpath(posixpath.join(base, target))


def _resolve_path(ctx: ToolContext, path: str) -> Path:
    if Path(path).is_absolute():
        return Path(path)
    return ctx.workdir / path


def _workspace_write_path(ctx: ToolContext, path: str) -> Path | str:
    """Keep built-in file writes under workdir, even in full mode.

    Local paths are resolved before use, so existing symlinks in any ancestor
    cannot redirect writes outside the workspace. The remote E2B backend is
    restricted lexically; it cannot inspect sandbox symlink targets here.
    This is not a shell/OS-level sandbox.
    """
    if not isinstance(path, str) or not path or "\x00" in path:
        raise ToolError("写入文件路径无效")
    if ctx.backend is not None:
        base = posixpath.normpath(str(ctx.workdir).replace("\\", "/"))
        target = _resolve_backend_path(ctx, path)
        if (not base.startswith("/") or target == base
                or not (target == base or target.startswith(base.rstrip("/") + "/"))):
            raise ToolError("禁止写入工作目录之外的路径")
        return target

    root = ctx.workdir.resolve()
    target = (root / path).resolve()
    if target == root or not target.is_relative_to(root):
        raise ToolError("禁止写入工作目录之外的路径")
    return target


_SESSION_FILE_TOOLS = frozenset(("write_file", "edit_file", "plan"))


def _workspace_shell_cwd(ctx: ToolContext, cwd: str | None) -> Path | str:
    """Validate and canonicalize the requested shell starting directory.

    This prevents starting outside workdir; the command itself can still
    change directories or write elsewhere, so this is NOT a shell sandbox.
    """
    if cwd is not None and (not isinstance(cwd, str) or "\x00" in cwd or not cwd):
        raise ToolError("shell 工作目录无效")
    if ctx.backend is not None:
        base = posixpath.normpath(str(ctx.workdir).replace("\\", "/"))
        target = _resolve_backend_path(ctx, cwd or ".")
        if not base.startswith("/") or not (
            target == base or target.startswith(base.rstrip("/") + "/")
        ):
            raise ToolError("禁止在工作目录之外启动 shell")
        return target
    root = ctx.workdir.resolve()
    target = (root / (cwd or ".")).resolve()
    if not target.is_relative_to(root):
        raise ToolError("禁止在工作目录之外启动 shell")
    if not target.is_dir():
        raise ToolError("shell 工作目录不存在")
    return target


def _approval_root(ctx: ToolContext) -> str:
    if ctx.backend is not None:
        return posixpath.normpath(str(ctx.workdir).replace("\\", "/"))
    return str(ctx.workdir.resolve())


def _check_approval(
    ctx: ToolContext, tool_name: str, summary: str, *,
    command: str | None = None, cwd: str | None = None,
    file_target: Path | str | None = None, timeout: int = 60,
) -> None:
    if tool_name not in MUTATING_TOOLS:
        return
    if ctx.mode == "readonly":
        raise ToolError(
            f"只读模式下不允许执行 {tool_name}，请用 --mode auto 或 --mode full"
        )
    if ctx.mode == "auto":
        if not ctx.interactive:
            raise ToolError(
                "非交互模式下 auto 模式不执行写入操作，请使用 --mode full 重新运行"
            )
        # A frontend approval callback always takes precedence: cached grants
        # from a previous terminal prompt must not bypass the Web UI gate.
        if ctx.approve_fn is not None:
            if not ctx.approve_fn(tool_name, summary):
                raise ToolError("用户拒绝执行")
            return

        file_scope = (
            tool_name, str(file_target), _approval_root(ctx), id(ctx.backend)
        ) if tool_name in _SESSION_FILE_TOOLS and file_target is not None else None
        shell_scope = (
            command, cwd, _approval_root(ctx), timeout, id(ctx.backend)
        ) if tool_name == "shell" and command is not None and cwd is not None else None
        if file_scope is not None and file_scope in ctx.approved_file_tools:
            return
        if shell_scope is not None and shell_scope in ctx.approved_shell_commands:
            return

        print(summary)
        if file_scope is not None:
            prompt = "允许执行吗？[y/N/a] (a=本次会话此工具对该文件始终允许) "
        elif shell_scope is not None:
            prompt = "允许执行吗？[y/N/a] (a=本次会话相同命令、目录、后端和超时始终允许) "
        else:
            prompt = "允许执行吗？[y/N] "
        answer = input(prompt).strip().lower()
        if answer in ("y", "yes"):
            return
        if answer in ("a", "always"):
            if file_scope is not None:
                ctx.approved_file_tools.add(file_scope)
                return
            if shell_scope is not None:
                ctx.approved_shell_commands.add(shell_scope)
                return
        raise ToolError("用户拒绝执行")
    if ctx.mode == "full":
        return


def _check_shell_denied(command: str) -> str | None:
    # Tokenization here is deliberately lightweight, not a shell parser.
    tokens = re.findall(
        r"""(?:[^\s;&|<>()"'\\]|\\.|"(?:\\.|[^"\\])*"|'[^']*')+|[;&|<>()]""",
        command,
    )
    tokens = [
        token[1:-1]
        if len(token) >= 2 and token[0] == token[-1] and token[0] in "\"'"
        else token
        for token in tokens
    ]
    dangerous_targets = {"/", "~", "$HOME", "${HOME}", "*", ".", ".."}
    separators = {";", "&", "|", "<", ">", "(", ")"}
    for index, token in enumerate(tokens):
        if token != "rm" and not token.endswith("/rm"):
            continue
        arguments: list[str] = []
        for argument in tokens[index + 1 :]:
            if argument in separators:
                break
            arguments.append(argument)
        if any(argument in ("-rf", "-fr") for argument in arguments):
            if any(
                argument in dangerous_targets or argument.startswith("/*")
                for argument in arguments
            ):
                return "禁止 rm -rf 删除根目录、家目录或通配路径"

    rules = [
        (r"\bsudo\s+rm\b", "禁止 sudo rm"),
        (r"\bmkfs(\.\w+)?\b", "禁止 mkfs 格式化命令"),
        (r"\bdd\b.*\bof=/dev/", "禁止 dd 写入设备"),
        (r"\b(shutdown|reboot|poweroff|halt)\b", "禁止关机/重启命令"),
        (r":\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;", "禁止 fork 炸弹"),
        (r">\s*/dev/(sd|hd|nvme|vd)[a-z0-9]*", "禁止重定向写入磁盘设备"),
        (r"\bchmod\s+-R\s+777\s+/", "禁止 chmod -R 777 /"),
        (r"\bchown\s+-R\b.*\s/$", "禁止 chown -R 到根目录"),
    ]
    for pattern, reason in rules:
        if re.search(pattern, command):
            return reason
    return None


def execute_local_read_file_report(ctx: ToolContext, path: str) -> tuple[str, "StructuredToolReport"]:
    """Read a local file with an in-process outcome, independent of file text.

    This does not attest to external side effects or authorize task recovery.
    Remote backends must continue through their existing execution path.
    """
    from .tool_report_status import StructuredToolReport

    if ctx.backend is not None:
        raise ToolError("structured local read requires a local backend")
    try:
        target = _resolve_path(ctx, path)
        if not target.is_file():
            return "错误：文件不存在", StructuredToolReport("reported_error")
        return _truncate(target.read_text(encoding="utf-8", errors="replace")), StructuredToolReport("reported_ok")
    except ToolError:
        return "错误：文件读取失败", StructuredToolReport("reported_error")
    except TypeError:
        return "错误：工具参数不正确", StructuredToolReport("reported_error")
    except Exception:
        # OS exception strings may contain absolute paths or other private data.
        return "执行失败：文件读取失败", StructuredToolReport("reported_error")


def _tool_read_file(ctx: ToolContext, path: str) -> str:
    if ctx.backend is not None:
        return _truncate(ctx.backend.read_file(_resolve_backend_path(ctx, path)))
    target = _resolve_path(ctx, path)
    if not target.is_file():
        return "错误：文件不存在"
    return _truncate(target.read_text(encoding="utf-8", errors="replace"))


def _write_local_text(ctx: ToolContext, target: Path, content: str) -> None:
    if ctx.checkpoint is not None and ctx.backend is None:
        try:
            ctx.checkpoint.write_text(target, content)
        except CheckpointError as exc:
            raise ToolError(str(exc)) from exc
    else:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")


def _change_preview(ctx: ToolContext, target: Path | str, new_content: str) -> str:
    """Preview an approved *local* write without leaking remote sandbox data."""
    if ctx.backend is not None:
        return "（远端文件不支持本地 diff 预览，请确认写入范围）"
    if not target.exists():
        old_bytes = None
    elif not target.is_file():
        raise ToolError("只能修改普通文件")
    elif target.stat().st_size > 2 * 1024 * 1024:
        return "（原文件超过 2 MiB，无法展示完整预览）"
    else:
        old_bytes = target.read_bytes()
    rel = target.relative_to(ctx.workdir.resolve()).as_posix()
    return unified_preview(rel, old_bytes, new_content.encode("utf-8"))


def _tool_write_file(ctx: ToolContext, path: str, content: str) -> str:
    target = _workspace_write_path(ctx, path)
    summary = f"写入文件：{path}（{len(content)} 字符）"
    if ctx.mode == "auto" and ctx.interactive:
        summary += "\n" + _change_preview(ctx, target, content)
    _check_approval(ctx, "write_file", summary, file_target=target)
    if ctx.backend is not None:
        return ctx.backend.write_file(str(target), content)
    _write_local_text(ctx, target, content)
    return f"已写入 {path}（{len(content)} 字符）"


def _tool_edit_file(
    ctx: ToolContext, path: str, old_text: str, new_text: str
) -> str:
    target = _workspace_write_path(ctx, path)
    if ctx.backend is not None:
        resolved = str(target)
        content = ctx.backend.read_file(resolved)
        if content.startswith("错误："):
            return content
        count = content.count(old_text)
        if count == 0:
            return "错误：未找到要替换的文本"
        if count > 1:
            return f"错误：找到 {count} 处匹配，请提供更精确的 old_text"
        changed = content.replace(old_text, new_text, 1)
        _check_approval(
            ctx, "edit_file", f"编辑文件：{path}\n（远端文件不支持本地 diff 预览）",
            file_target=target,
        )
        return ctx.backend.write_file(resolved, changed)
    if not target.is_file():
        # Do not expose caller-supplied private paths to the model.
        return "错误：文件不存在"
    content = target.read_text(encoding="utf-8")
    count = content.count(old_text)
    if count == 0:
        return "错误：未找到要替换的文本"
    if count > 1:
        return f"错误：找到 {count} 处匹配，请提供更精确的 old_text"
    changed = content.replace(old_text, new_text, 1)
    summary = f"编辑文件：{path}"
    if ctx.mode == "auto" and ctx.interactive:
        summary += "\n" + unified_preview(
            target.relative_to(ctx.workdir.resolve()).as_posix(),
            content.encode("utf-8"), changed.encode("utf-8"),
        )
    _check_approval(ctx, "edit_file", summary, file_target=target)
    if target.read_text(encoding="utf-8") != content:
        raise ToolError("审批期间文件已发生变化，请重新生成补丁")
    _write_local_text(ctx, target, changed)
    return f"已编辑 {path}"


def _tool_apply_patch(ctx: ToolContext, path: str, patch: str) -> str:
    # One local file per invocation: the checkpoint store tracks the original
    # bytes and the strict parser rejects stale hunk context.
    if ctx.backend is not None:
        raise ToolError("apply_patch 当前只支持本地工作目录，不支持 E2B")
    target = _workspace_write_path(ctx, path)
    if not target.is_file():
        raise ToolError("补丁目标必须是已存在的普通本地文件")
    before = target.read_bytes()
    try:
        relative = target.relative_to(ctx.workdir.resolve()).as_posix()
        replacement = apply_unified_patch(before.decode("utf-8"), patch, relative)
    except (UnicodeDecodeError, PatchError) as exc:
        raise ToolError(f"补丁无效：{exc}") from exc
    preview = unified_preview(relative, before, replacement.encode("utf-8"))
    _check_approval(
        ctx, "apply_patch", f"应用补丁：{relative}\n{preview}", file_target=target,
    )
    if target.read_bytes() != before:
        raise ToolError("审批期间目标文件已发生变化，拒绝应用过期补丁")
    _write_local_text(ctx, target, replacement)
    return f"已应用补丁 {relative}"


def execute_local_list_dir_report(ctx: ToolContext, path: str = ".") -> tuple[str, "StructuredToolReport"]:
    """Return local directory listing and in-process outcome separately.

    This is not an external acceptance receipt. Do not use for remote backends.
    """
    from .tool_report_status import StructuredToolReport

    if ctx.backend is not None:
        raise ToolError("structured local listing requires a local backend")
    try:
        target = _resolve_path(ctx, path)
        if not target.is_dir():
            return "错误：目录不存在", StructuredToolReport("reported_error")
        entries = sorted(target.iterdir(), key=lambda entry: (not entry.is_dir(), entry.name))
        lines = [
            f"{entry.name}/"
            if entry.is_dir()
            else f"{entry.name} ({entry.stat().st_size} 字节)"
            for entry in entries
        ]
        return "\n".join(lines) or "（空目录）", StructuredToolReport("reported_ok")
    except ToolError:
        # Explicit errors can also contain caller-provided private paths.
        return "错误：目录读取失败", StructuredToolReport("reported_error")
    except TypeError:
        return "错误：工具参数不正确", StructuredToolReport("reported_error")
    except Exception:
        # OS errors may contain absolute private paths or mount details.
        # Keep the model-visible failure generic; the typed status is authoritative.
        return "执行失败：目录读取失败", StructuredToolReport("reported_error")


def _tool_list_dir(ctx: ToolContext, path: str = ".") -> str:
    if ctx.backend is not None:
        return ctx.backend.list_dir(_resolve_backend_path(ctx, path))
    return execute_local_list_dir_report(ctx, path)[0]


def execute_local_shell_report(
    ctx: ToolContext, command: str, cwd: str | None = None,
    timeout: int = 60,
) -> tuple[str, "StructuredToolReport"]:
    """Local shell outcome from subprocess exit metadata, not stdout text.

    Existing approval and deny rules apply. This is not proof of external
    side effects; remote backends retain their legacy execution path.
    """
    from .tool_report_status import StructuredToolReport

    if ctx.backend is not None:
        raise ToolError("structured local shell requires a local backend")
    denied = _check_shell_denied(command)
    if denied:
        return f"错误：{denied}", StructuredToolReport("reported_error")
    resolved_cwd = _workspace_shell_cwd(ctx, cwd)
    _check_approval(
        ctx, "shell", f"执行命令：{command}（cwd: {resolved_cwd}；timeout: {timeout}s）",
        command=command, cwd=str(resolved_cwd), timeout=timeout,
    )
    try:
        result = subprocess.run(
            command, shell=True, cwd=resolved_cwd, capture_output=True,
            text=True, timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return f"错误：命令超时（{timeout} 秒）", StructuredToolReport("unknown")
    combined = result.stdout
    if result.stderr:
        if combined and not combined.endswith("\\n"):
            combined += "\\n"
        combined += "标准错误：\\n" + result.stderr
    if result.returncode != 0:
        return (
            f"错误：命令退出码 {result.returncode}\\n" + (_truncate(combined) or "（无输出）"),
            StructuredToolReport("reported_error"),
        )
    return _truncate(combined) or "（无输出）", StructuredToolReport("reported_ok")


def _tool_shell(
    ctx: ToolContext,
    command: str,
    cwd: str | None = None,
    timeout: int = 60,
) -> str:
    if ctx.backend is None:
        return execute_local_shell_report(ctx, command, cwd, timeout)[0]
    denied = _check_shell_denied(command)
    if denied:
        return f"错误：{denied}"
    resolved_cwd = _workspace_shell_cwd(ctx, cwd)
    _check_approval(
        ctx, "shell", f"执行命令：{command}（cwd: {resolved_cwd}；timeout: {timeout}s）",
        command=command, cwd=str(resolved_cwd), timeout=timeout,
    )
    if ctx.backend is not None:
        return _truncate(
            ctx.backend.run_command(command, cwd=str(resolved_cwd), timeout=timeout)
        ) or "（无输出）"

def _tool_web_fetch(ctx: ToolContext, url: str) -> str:
    try:
        request = urllib.request.Request(url, headers={"User-Agent": "Angel/0.2"})
        with open_url(request, 30) as response:
            charset = response.headers.get_content_charset() or "utf-8"
            byte_limit = MAX_OUTPUT_CHARS * 4
            payload = response.read(byte_limit + 1)
            clipped = len(payload) > byte_limit
            text = payload[:byte_limit].decode(charset, errors="replace")
        cleaned = re.sub(r"<[^>]+>", " ", text)
        cleaned = re.sub(r"\s+", " ", cleaned).strip()
        if clipped:
            cleaned += "\n……（网页正文超过读取上限，证据仅包含已读取部分）"
        body = _truncate(cleaned)
        if ctx.evidence is not None:
            path = ctx.evidence.save("web_fetch", url, cleaned)
            # URLs can contain query tokens or credentials. Do not echo them
            # again in the model-visible evidence marker.
            body += f"\n\n[证据已保存：{path}]"
        return body
    except Exception:
        # Network exceptions can include private URLs, tokens or headers.
        return "错误：抓取失败"


def _parse_baidu_html(text: str, count: int) -> list[str]:
    """Parse Baidu result titles/abstracts into display lines."""
    lowered = text.lower()
    if (
        "百度安全验证" in text
        or "请输入验证码" in text
        or "captcha" in lowered
    ):
        raise ToolError("百度要求安全验证")
    titles = re.findall(
        r"<h3[^>]*>\s*<a[^>]*href=\"([^\"]+)\"[^>]*>(.*?)</a>",
        text,
        re.S,
    )
    abstracts = re.findall(
        r"class=\"c-abstract[^\"]*\"[^>]*>(.*?)</(?:div|span)>",
        text,
        re.S,
    )
    results: list[str] = []
    for index, (href, title) in enumerate(titles[:max(0, count)]):
        href = html.unescape(href).strip()
        title = html.unescape(re.sub(r"<[^>]+>", "", title)).strip()
        if not title or not href:
            continue
        snippet = abstracts[index] if index < len(abstracts) else ""
        snippet = html.unescape(re.sub(r"<[^>]+>", "", snippet)).strip()
        results.append(f"{index + 1}. {title}\n   {href}\n   {snippet}")
    return results


def _parse_bing_html(text: str, count: int) -> list[str]:
    """Parse Bing result blocks into display lines."""
    lowered = text.lower()
    if "captcha" in lowered or "请输入验证码" in text or "not a robot" in lowered:
        raise ToolError("Bing 要求人机验证")
    blocks = re.findall(
        r'<li class="b_algo".*?<h2><a[^>]*href="([^"]+)"[^>]*>(.*?)</a>.*?<p[^>]*>(.*?)</p>',
        text,
        re.S,
    )
    results: list[str] = []
    for index, (href, title, snippet) in enumerate(blocks[:max(0, count)]):
        href = html.unescape(href).strip()
        title = html.unescape(re.sub(r"<[^>]+>", "", title)).strip()
        snippet = html.unescape(re.sub(r"<[^>]+>", "", snippet)).strip()
        if not title and not href:
            continue
        results.append(f"{index + 1}. {title}\n   {href}\n   {snippet}")
    return results


def _fetch_search_page(url: str) -> str:
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": (
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
            ),
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        },
    )
    with open_url(request, 30) as response:
        charset = response.headers.get_content_charset() or "utf-8"
        # Search HTML is untrusted and may be arbitrarily large. Reject a
        # partial page rather than parsing incomplete results as evidence.
        byte_limit = 128 * 1024
        payload = response.read(byte_limit + 1)
        if len(payload) > byte_limit:
            raise ToolError("搜索页面超过读取上限")
        return payload.decode(charset, errors="replace")


def _tool_web_search(ctx: ToolContext, query: str, count: int = 8) -> str:
    """Search the web with a fallback chain; never fabricate results.

    后端顺序按 IllusionAgent 的做法：必应优先，百度兜底。每次搜索都用
    全新的请求（不共享 cookie/会话），失败时明确报错，不编结果。
    """
    errors: list[str] = []
    sources = [
        (
            "Bing",
            "https://www.bing.com/search?q=" + urllib.parse.quote(query),
            _parse_bing_html,
        ),
        (
            "百度",
            "https://www.baidu.com/s?wd=" + urllib.parse.quote(query),
            _parse_baidu_html,
        ),
    ]
    for name, url, parser in sources:
        try:
            results = parser(_fetch_search_page(url), count)
        except ToolError:
            # Search backend errors may contain request URLs, query terms or credentials.
            errors.append(f"{name}：搜索源拒绝请求")
            continue
        except Exception:
            # Never forward arbitrary network exception details to the model.
            errors.append(f"{name}：请求失败")
            continue
        if results:
            body = "\n\n".join(results)
            if ctx.evidence is not None:
                path = ctx.evidence.save("web_search", url, body, query=query)
                body += f"\n\n[证据已保存：{path}]"
            return body
        errors.append(f"{name}：未返回可解析的结果")
    return "错误：搜索失败（" + "；".join(errors) + "），请稍后重试或换个网络"


def _tool_memory_append(ctx: ToolContext, text: str) -> str:
    _check_approval(ctx, "memory_append", f"写入记忆：{text[:60]}")
    append_memory(text, path=ctx.memory_path)
    return "已写入长期记忆"


def _tool_save_skill(
    ctx: ToolContext,
    name: str,
    description: str,
    when: str,
    keywords: str | list[str],
    instructions: str,
) -> str:
    _check_approval(ctx, "save_skill", f"保存技能：{name}")
    keywords_list = (
        [keyword.strip() for keyword in re.split(r"[,、]", keywords) if keyword.strip()]
        if isinstance(keywords, str)
        else keywords
    )
    save_skill_file(
        ctx.skills_dir, name, description, when, keywords_list, instructions
    )
    return f"已保存技能 {name}"


def _tool_delegate(ctx: ToolContext, task: str, max_turns: int = 6) -> str:
    if ctx.delegate_fn is None:
        return "错误：子 agent 不可用"
    return ctx.delegate_fn(task, max_turns)


def _tool_plan(
    ctx: ToolContext,
    title: str,
    steps: list[str],
    path: str = "plan.md",
) -> str:
    target = _workspace_write_path(ctx, path)
    content = (
        f"# {title}\n\n"
        + "\n".join(f"{i}. {s}" for i, s in enumerate(steps, 1))
        + "\n"
    )
    summary = f"写入计划文件：{path}"
    if ctx.mode == "auto" and ctx.interactive:
        summary += "\n" + _change_preview(ctx, target, content)
    _check_approval(ctx, "plan", summary, file_target=target)
    if ctx.backend is not None:
        ctx.backend.write_file(str(target), content)
        return f"已写入计划 {path}（{len(steps)} 步）"
    _write_local_text(ctx, target, content)
    return f"已写入计划 {path}（{len(steps)} 步）"


_SKIP_DIRS = {".git", "__pycache__", "node_modules", ".venv", "venv", ".idea", ".vscode"}


def _tool_grep_search(
    ctx: ToolContext,
    pattern: str,
    path: str = ".",
    regex: bool = False,
    case_sensitive: bool = False,
    max_results: int = 50,
) -> str:
    if ctx.backend is not None:
        if regex:
            try:
                re.compile(pattern, 0 if case_sensitive else re.IGNORECASE)
            except re.error:
                return "错误：正则表达式无效"
        flags = ["-rn"]
        if regex:
            flags.append("-E")
        if not case_sensitive:
            flags.append("-i")
        excludes = " ".join(
            f"--exclude-dir={d}" for d in sorted(_SKIP_DIRS | {".*"})
        )
        command = (
            f"grep {' '.join(flags)} {excludes} -- "
            f"{shlex.quote(pattern)} {shlex.quote(_resolve_backend_path(ctx, path))}"
        )
        out = ctx.backend.run_command(command, cwd=_resolve_backend_path(ctx, "."), timeout=30)
        if "No such file or directory" in out:
            return "错误：路径不存在"
        lines = [line for line in out.splitlines() if line.strip()]
        if not lines:
            return "未找到匹配内容"
        found = lines[:max_results]
        result = "\n".join(found)
        if len(lines) > max_results:
            result += f"\n……（已达上限 {max_results} 条）"
        return result
    root = _resolve_path(ctx, path)
    if not root.exists():
        return "错误：路径不存在"
    if regex:
        flags = 0 if case_sensitive else re.IGNORECASE
        try:
            compiled = re.compile(pattern, flags)
        except re.error:
            return "错误：正则表达式无效"
        match = lambda line: compiled.search(line) is not None
    else:
        needle = pattern if case_sensitive else pattern.lower()
        match = lambda line: needle in (line if case_sensitive else line.lower())

    found: list[str] = []
    files = [root] if root.is_file() else sorted(root.rglob("*"))
    for entry in files:
        if len(found) >= max_results:
            break
        if entry.is_dir():
            continue
        if any(part in _SKIP_DIRS or part.startswith(".") and part != "." for part in entry.relative_to(root).parts[:-1]):
            continue
        try:
            text = entry.read_text(encoding="utf-8", errors="strict")
        except (OSError, UnicodeDecodeError, ValueError):
            continue
        for lineno, line in enumerate(text.splitlines(), 1):
            if match(line):
                rel = entry.relative_to(ctx.workdir) if entry.is_relative_to(ctx.workdir) else entry
                found.append(f"{rel}:{lineno}: {line.strip()[:200]}")
                if len(found) >= max_results:
                    break
    if not found:
        return "未找到匹配内容"
    out = "\n".join(found)
    if len(found) >= max_results:
        out += f"\n……（已达上限 {max_results} 条）"
    return out


def _tool_git_status(ctx: ToolContext, path: str = ".") -> str:
    if ctx.backend is not None:
        target = _resolve_backend_path(ctx, path)
        out = ctx.backend.run_command(
            f"git -C {shlex.quote(str(target))} status --short --branch",
            cwd=_resolve_backend_path(ctx, "."),
            timeout=15,
        )
        if "fatal: not a git repository" in out or "不是一个 git 仓库" in out:
            return "错误：该目录不是 git 仓库（或 git 报错）"
        diff = ctx.backend.run_command(
            f"git -C {shlex.quote(str(target))} diff --stat",
            cwd=_resolve_backend_path(ctx, "."),
            timeout=15,
        )
        combined = out.strip() or "（工作区干净）"
        if diff.strip() and "fatal" not in diff:
            combined += "\n\n改动统计：\n" + diff.strip()
        return _truncate(combined)
    target = _resolve_path(ctx, path)
    if not target.is_dir():
        # Caller-supplied paths can contain private names or credentials.
        return "错误：目录不存在"
    try:
        status = subprocess.run(
            ["git", "-C", str(target), "status", "--short", "--branch"],
            capture_output=True, text=True, timeout=15,
        )
    except FileNotFoundError:
        return "错误：本机未安装 git"
    except subprocess.TimeoutExpired:
        return "错误：git status 超时"
    if status.returncode != 0:
        return "错误：该目录不是 git 仓库（或 git 报错）"
    try:
        diff = subprocess.run(
            ["git", "-C", str(target), "diff", "--stat"],
            capture_output=True, text=True, timeout=15,
        )
    except FileNotFoundError:
        return "错误：本机未安装 git"
    except subprocess.TimeoutExpired:
        # A partial status is not a complete status/diff snapshot.
        return "错误：git diff 超时"
    # A failed diff cannot be reported as a complete status snapshot.
    # Do not expose stderr: git errors can contain private repository paths.
    if diff.returncode != 0:
        return "错误：git diff 失败（状态快照不完整）"
    out = (status.stdout or "（工作区干净）").strip()
    if diff.stdout.strip():
        out += "\n\n改动统计：\n" + diff.stdout.strip()
    return _truncate(out)


def _tool_http_post(
    ctx: ToolContext,
    url: str,
    body: str = "",
    content_type: str = "application/json",
) -> str:
    _check_approval(ctx, "http_post", f"POST 请求：{url}")
    try:
        request = urllib.request.Request(
            url,
            data=body.encode("utf-8"),
            method="POST",
            headers={"Content-Type": content_type, "User-Agent": "Angel/0.2"},
        )
        with open_url(request, 30) as response:
            # Check status before reading or decoding any untrusted body.
            # Some transports return non-2xx responses without HTTPError.
            # POST side effects are uncertain; never retry automatically.
            if not 200 <= response.status < 300:
                return f"错误：HTTP {response.status}"
            charset = response.headers.get_content_charset() or "utf-8"
            # Bound network input before decoding. A 4-byte UTF-8 character
            # can require four bytes per displayed character; other encodings
            # are still bounded by this byte limit. Never claim a full length.
            byte_limit = MAX_OUTPUT_CHARS * 4
            payload = response.read(byte_limit + 1)
            clipped = len(payload) > byte_limit
            text = payload[:byte_limit].decode(charset, errors="replace")
            result = _truncate(text)
            if clipped:
                result += "\n……（响应正文超过读取上限，剩余内容未读取）"
            return f"HTTP {response.status}\n{result}"
    except urllib.error.HTTPError as exc:
        # Untrusted response bodies can echo tokens or submitted data.
        # Preserve trusted status only; never retry an uncertain POST.
        return f"错误：HTTP {exc.code}"
    except Exception:
        return "错误：POST 请求失败"


def _tool_poppy_discover(ctx: ToolContext, site: str) -> str:
    if not ctx.poppy_enabled:
        raise ToolError("Poppy 发现未启用，需要显式设置 --poppy")
    try:
        result = discover_poppy(site)
    except PoppyError as exc:
        raise ToolError(str(exc)) from exc
    import json
    return json.dumps(result, ensure_ascii=False)


def _tool_poppy_identity_check(ctx: ToolContext, site: str) -> str:
    if not ctx.poppy_enabled:
        raise ToolError("Poppy OAuth 元数据核验未启用，需显式 --poppy")
    try:
        result = inspect_poppy_identity(site)
    except (IdentityError, PoppyError, OSError) as exc:
        raise ToolError(str(exc)) from exc
    import json
    return json.dumps(result, ensure_ascii=False)


def _tool_poppy_permission_check(
    ctx: ToolContext, site: str, scope: str, account: str | None = None,
) -> str:
    if not ctx.poppy_enabled:
        raise ToolError("Poppy 发现和权限检查未启用，请显式设置 --poppy")
    try:
        result = PermissionLedger().check(site, scope, account=account)
    except (PermissionError, OSError) as exc:
        raise ToolError(str(exc)) from exc
    import json
    return json.dumps(result, ensure_ascii=False)


def execute_tool(name: str, arguments: dict, ctx: ToolContext) -> str:
    dispatch: dict[str, Callable[..., str]] = {
        "read_file": _tool_read_file,
        "write_file": _tool_write_file,
        "edit_file": _tool_edit_file,
        "apply_patch": _tool_apply_patch,
        "list_dir": _tool_list_dir,
        "shell": _tool_shell,
        "web_fetch": _tool_web_fetch,
        "web_search": _tool_web_search,
        "memory_append": _tool_memory_append,
        "save_skill": _tool_save_skill,
        "delegate": _tool_delegate,
        "plan": _tool_plan,
        "grep_search": _tool_grep_search,
        "git_status": _tool_git_status,
        "http_post": _tool_http_post,
        "poppy_discover": _tool_poppy_discover,
        "poppy_permission_check": _tool_poppy_permission_check,
        "poppy_identity_check": _tool_poppy_identity_check,
    }
    tool = dispatch.get(name)
    if tool is None:
        # Untrusted tool names may contain private arguments or credentials.
        return "错误：未知工具"
    try:
        return tool(ctx, **arguments)
    except ToolError:
        # ToolError may wrap OS, backend or permission exceptions containing
        # caller paths, URLs or credentials. Never echo its untrusted text.
        # Keep the legacy error prefix for failure classification.
        return "错误：工具执行被拒绝或失败"
    except TypeError:
        # Argument values may include private paths or credentials.
        return "错误：工具参数不正确"
    except Exception:
        # Do not forward arbitrary exception strings to the model.
        return "执行失败：工具执行失败"

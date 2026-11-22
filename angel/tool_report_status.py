"""Conservative classification of legacy tool reports.

This is a compatibility boundary, not evidence of a completed operation.
Unknown or non-text returns remain unverified and never grant resume authority.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class ToolReportStatus:
    reported_failure: bool
    execution_verified: bool = False
    safe_to_auto_resume: bool = False


def classify_tool_report(result: object, *, raised: bool = False) -> ToolReportStatus:
    """Classify known legacy error prefixes without trusting success text.

    Explicit exceptions take precedence. A plain result without a recognized
    prefix is *not* proof of successful external side effects.
    """
    if type(raised) is not bool:
        raise ValueError("raised must be boolean")
    failed = raised or (
        isinstance(result, str)
        and result.startswith(("错误：", "执行失败："))
    )
    return ToolReportStatus(reported_failure=failed)

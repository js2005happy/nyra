"""Conservative classification of legacy tool reports.

This is a compatibility boundary, not evidence of a completed operation.
Unknown or non-text returns remain unverified and never grant resume authority.
"""

from dataclasses import dataclass
from typing import Literal


@dataclass(frozen=True)
class StructuredToolReport:
    """Explicit in-process tool outcome, not a claim of external verification.

    This type is opt-in for trusted tool adapters only. Never deserialize
    untrusted JSON into it or infer it from a model/tool text response.
    """
    outcome: Literal["reported_ok", "reported_error", "unknown"]

    def __post_init__(self) -> None:
        if type(self.outcome) is not str or self.outcome not in {
            "reported_ok", "reported_error", "unknown"
        }:
            raise ValueError("invalid structured tool outcome")


@dataclass(frozen=True)
class ToolReportStatus:
    reported_failure: bool
    reported_unknown: bool = False
    execution_verified: bool = False
    safe_to_auto_resume: bool = False


def classify_tool_report(result: object, *, raised: bool = False) -> ToolReportStatus:
    """Classify known legacy error prefixes without trusting success text.

    Explicit exceptions take precedence. A plain result without a recognized
    prefix is *not* proof of successful external side effects.
    """
    if type(raised) is not bool:
        raise ValueError("raised must be boolean")
    if type(result) is StructuredToolReport:
        return ToolReportStatus(
            reported_failure=raised or result.outcome == "reported_error",
            reported_unknown=not raised and result.outcome == "unknown",
        )
    # Legacy adapters are expected to return text. Non-text values have no
    # authenticated outcome and must not be journaled as reported success.
    if not isinstance(result, str):
        return ToolReportStatus(reported_failure=raised, reported_unknown=not raised)
    failed = raised or result.startswith(("错误：", "执行失败："))
    return ToolReportStatus(reported_failure=failed)

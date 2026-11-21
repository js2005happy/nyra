"""Pure, bounded no-progress signal for long-running Agent workflows.

This is an advisory observer, not a task completion oracle or an automatic
cancellation mechanism. Callers must explicitly report *trusted* progress;
model prose and polling events are not proof of progress.
"""
from dataclasses import dataclass


class ProgressSignalError(ValueError):
    """Invalid progress observation."""


@dataclass(frozen=True)
class ProgressSnapshot:
    consecutive_idle: int
    needs_attention: bool
    execution_verified: bool = False
    safe_to_auto_resume: bool = False


class NoProgressDetector:
    """Count consecutive idle observations without recording user content.

    The observer deliberately has no clocks, I/O, automatic retries or hooks
    into the Agent loop. A caller must distinguish trusted progress from
    commentary; successful polling is still idle.
    """

    def __init__(self, idle_limit: int = 5) -> None:
        if type(idle_limit) is not int or not 1 <= idle_limit <= 1000:
            raise ProgressSignalError("invalid idle limit")
        self._limit = idle_limit
        self._idle = 0

    def observe(self, *, progress: bool) -> ProgressSnapshot:
        if type(progress) is not bool:
            raise ProgressSignalError("progress must be boolean")
        self._idle = 0 if progress else min(self._idle + 1, self._limit)
        return self.snapshot()

    def snapshot(self) -> ProgressSnapshot:
        return ProgressSnapshot(
            consecutive_idle=self._idle,
            needs_attention=self._idle >= self._limit,
        )

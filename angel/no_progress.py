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

    def reset_run(self) -> ProgressSnapshot:
        """Start a new explicit task without inheriting earlier idle counts.

        This only clears advisory metadata; it does not verify execution,
        cancel tools, or grant permission to resume a task.
        """
        self._idle = 0
        return self.snapshot()

    def snapshot(self) -> ProgressSnapshot:
        return ProgressSnapshot(
            consecutive_idle=self._idle,
            needs_attention=self._idle >= self._limit,
        )

    def observe_event(self, event: str, *, trusted: bool = False) -> ProgressSnapshot:
        """Classify a small, explicit event vocabulary without storing payloads.

        Only a caller-attested deliverable event can reset the idle streak.
        The attestation must come from an independent trusted controller,
        never from model text or an untrusted tool response.
        """
        if type(event) is not str or event not in {
            "model_message", "status_poll", "tool_returned",
            "deliverable_committed", "acceptance_confirmed",
        }:
            raise ProgressSignalError("unknown progress event")
        if type(trusted) is not bool:
            raise ProgressSignalError("trusted must be boolean")
        if trusted and event not in {"deliverable_committed", "acceptance_confirmed"}:
            raise ProgressSignalError("event cannot attest progress")
        return self.observe(
            progress=trusted and event in {"deliverable_committed", "acceptance_confirmed"}
        )

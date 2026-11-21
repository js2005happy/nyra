"""Bounded, in-memory task contract validation (no persistence or execution).

This is a data boundary, not an authorization mechanism. Never include prompts,
credentials, tool arguments, outputs or private user content in contract fields.
"""
from __future__ import annotations

from collections.abc import Mapping, Sequence


class TaskContractError(ValueError):
    """Invalid task contract; fail closed."""


_ALLOWED = {"task_id", "revision", "requirements", "prohibitions", "phase"}
_PHASES = {"planned", "working", "blocked", "review", "complete_reported"}


def validate_task_contract(contract: Mapping[str, object]) -> dict[str, object]:
    """Return a detached, normalized metadata-only contract.

    A reported completion is not independent verification and never authorizes
    automatic execution or replay. No file, network, clock or model operations.
    """
    if not isinstance(contract, Mapping) or set(contract) != _ALLOWED:
        raise TaskContractError("invalid contract fields")

    def bounded(value: object, limit: int = 160) -> str:
        if (not isinstance(value, str) or not value.strip()
                or len(value) > limit or any(ord(c) < 32 for c in value)):
            raise TaskContractError("invalid contract metadata")
        return value

    task_id = bounded(contract["task_id"], 100)
    revision = bounded(contract["revision"], 200)
    phase = bounded(contract["phase"], 40)
    if phase not in _PHASES:
        raise TaskContractError("unknown phase")

    def labels(value: object, limit: int) -> list[str]:
        if (isinstance(value, (str, bytes)) or not isinstance(value, Sequence)
                or not 1 <= len(value) <= limit):
            raise TaskContractError("invalid contract labels")
        result = [bounded(item) for item in value]
        if len(set(result)) != len(result):
            raise TaskContractError("duplicate contract labels")
        return result

    requirements = labels(contract["requirements"], 100)
    prohibitions = labels(contract["prohibitions"], 50)
    if set(requirements) & set(prohibitions):
        raise TaskContractError("conflicting contract labels")
    return {
        "task_id": task_id, "revision": revision,
        "requirements": requirements, "prohibitions": prohibitions,
        "phase": phase, "execution_verified": False,
        "safe_to_auto_resume": False,
    }

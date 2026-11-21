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


# This format is deliberately a *transport envelope*, not a resumable checkpoint.
# Persisting it is a separate, explicitly authorized operation.
import json

_CONTRACT_FIELDS = ("task_id", "revision", "requirements", "prohibitions", "phase")
_MAX_ENVELOPE_BYTES = 32768
_FORMAT_VERSION = 1


def encode_task_contract(contract: Mapping[str, object]) -> bytes:
    """Serialize only validated metadata; never serialize caller-supplied extras.

    The unverified/auto-resume flags are deliberately excluded from the wire
    format and regenerated on import. No disk, clock, network or execution.
    """
    normalized = validate_task_contract(contract)
    envelope = {
        "format": "angel.task_contract",
        "version": _FORMAT_VERSION,
        "contract": {field: normalized[field] for field in _CONTRACT_FIELDS},
    }
    try:
        payload = json.dumps(envelope, ensure_ascii=True, sort_keys=True,
                             separators=(",", ":"), allow_nan=False).encode("ascii")
    except (TypeError, ValueError, UnicodeError) as exc:
        raise TaskContractError("invalid contract serialization") from exc
    if len(payload) > _MAX_ENVELOPE_BYTES:
        raise TaskContractError("contract envelope too large")
    return payload


def decode_task_contract(payload: bytes) -> dict[str, object]:
    """Strictly import a bounded metadata envelope without granting authority."""
    if not isinstance(payload, bytes) or not 0 < len(payload) <= _MAX_ENVELOPE_BYTES:
        raise TaskContractError("invalid contract envelope size")
    try:
        envelope = json.loads(payload.decode("utf-8"),
                              object_pairs_hook=_unique_json_pairs,
                              parse_constant=_reject_json_constant)
    except (UnicodeError, ValueError, TypeError, RecursionError) as exc:
        raise TaskContractError("invalid contract envelope") from exc
    if (not isinstance(envelope, dict)
            or set(envelope) != {"format", "version", "contract"}
            or envelope["format"] != "angel.task_contract"
            or type(envelope["version"]) is not int
            or envelope["version"] != _FORMAT_VERSION):
        raise TaskContractError("unsupported contract envelope")
    return validate_task_contract(envelope["contract"])


def _unique_json_pairs(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result = {}
    for key, value in pairs:
        if key in result:
            raise TaskContractError("duplicate JSON key")
        result[key] = value
    return result


def _reject_json_constant(value: str) -> None:
    raise TaskContractError("nonfinite JSON constant")

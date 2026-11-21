"""Regression definitions only: do not execute without explicit authorization."""
import unittest

from angel.task_contract import encode_task_contract, decode_task_contract

from angel.task_contract import TaskContractError, validate_task_contract


class TaskContractTests(unittest.TestCase):
    def setUp(self):
        self.data = dict(task_id="task-1", revision="abc123",
                         requirements=["review diff"], prohibitions=["no deploy"],
                         phase="working")

    def test_detached_and_unverified(self):
        result = validate_task_contract(self.data)
        self.assertFalse(result["execution_verified"])
        self.assertFalse(result["safe_to_auto_resume"])
        result["requirements"].append("other")
        self.assertEqual(self.data["requirements"], ["review diff"])

    def test_unknown_field(self):
        with self.assertRaises(TaskContractError):
            validate_task_contract({**self.data, "secret": "value"})

    def test_duplicate_requirement(self):
        with self.assertRaises(TaskContractError):
            validate_task_contract({**self.data, "requirements": ["a", "a"]})

    def test_invalid_phase(self):
        with self.assertRaises(TaskContractError):
            validate_task_contract({**self.data, "phase": "verified"})

    def test_conflicting_labels(self):
        with self.assertRaises(TaskContractError):
            validate_task_contract({**self.data, "requirements": ["no deploy"]})

    def test_control_character(self):
        with self.assertRaises(TaskContractError):
            validate_task_contract({**self.data, "task_id": "bad\nname"})


    def test_wire_roundtrip_remains_unverified(self):
        restored = decode_task_contract(encode_task_contract(self.data))
        self.assertEqual(restored["task_id"], "task-1")
        self.assertFalse(restored["execution_verified"])
        self.assertFalse(restored["safe_to_auto_resume"])

    def test_wire_rejects_unknown_fields(self):
        payload = b'{"format":"angel.task_contract","version":1,"contract":{"task_id":"x","secret":"no"}}'
        with self.assertRaises(TaskContractError):
            decode_task_contract(payload)

    def test_wire_rejects_duplicate_json_keys(self):
        payload = encode_task_contract(self.data).replace(b'"version":1', b'"version":1,"version":1')
        with self.assertRaises(TaskContractError):
            decode_task_contract(payload)

    def test_wire_rejects_oversize(self):
        with self.assertRaises(TaskContractError):
            decode_task_contract(b" " * 32769)

    def test_wire_rejects_future_version_and_boolean(self):
        payload = encode_task_contract(self.data)
        for changed in (b'"version":2', b'"version":true'):
            with self.assertRaises(TaskContractError):
                decode_task_contract(payload.replace(b'"version":1', changed))

    def test_wire_rejects_derived_authority_flags(self):
        payload = encode_task_contract(self.data).replace(
            b'"contract":{', b'"contract":{"safe_to_auto_resume":true,')
        with self.assertRaises(TaskContractError):
            decode_task_contract(payload)


if __name__ == "__main__":
    unittest.main()

"""Regression definitions only: do not execute without explicit authorization."""
import unittest

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
            validate_task_contract({**self.data, "task_id": "bad\\nname"})


if __name__ == "__main__":
    unittest.main()

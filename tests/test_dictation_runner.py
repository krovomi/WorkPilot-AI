"""Offline contract tests; no model download or microphone needed."""

# Load the standalone runner without importing runners/__init__.py and its
# unrelated LLM SDK/platform dependencies.
import importlib.util
import unittest
from pathlib import Path
from unittest.mock import Mock

runner_path = (
    Path(__file__).resolve().parents[1] / "apps/backend/runners/dictation_runner.py"
)
spec = importlib.util.spec_from_file_location("workpilot_dictation_runner", runner_path)
assert spec and spec.loader
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
transcribe_audio = runner.transcribe_audio


class DictationTests(unittest.TestCase):
    def test_regional_language_and_unicode(self):
        model = Mock()
        model.transcribe.return_value = (
            [Mock(text=" Bonjour, Überprüfung mañana. ")],
            None,
        )
        self.assertEqual(
            transcribe_audio(model, b"audio", "fr-CA"), "Bonjour, Überprüfung mañana."
        )
        self.assertEqual(model.transcribe.call_args.kwargs["language"], "fr")
        self.assertEqual(model.transcribe.call_args.kwargs["task"], "transcribe")

    def test_auto_detection_and_silence(self):
        model = Mock()
        model.transcribe.return_value = ([], None)
        self.assertEqual(transcribe_audio(model, b"audio", "auto"), "")
        self.assertIsNone(model.transcribe.call_args.kwargs["language"])

    def test_rejects_unknown_language(self):
        with self.assertRaises(ValueError):
            transcribe_audio(Mock(), b"audio", "invalid")


if __name__ == "__main__":
    unittest.main()

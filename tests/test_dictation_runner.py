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
transcribe_with_language = runner.transcribe_with_language


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

    def test_auto_reports_the_language_whisper_heard(self):
        model = Mock()
        model.transcribe.return_value = (
            [Mock(text=" Ouvre le Kanban ")],
            Mock(language="fr", language_probability=0.93),
        )
        self.assertEqual(
            transcribe_with_language(model, b"audio", "auto"), ("Ouvre le Kanban", "fr")
        )

    def test_a_chosen_language_is_not_reported_again(self):
        model = Mock()
        model.transcribe.return_value = (
            [Mock(text="Open the board")],
            Mock(language="en", language_probability=0.99),
        )
        self.assertEqual(
            transcribe_with_language(model, b"audio", "en-US"), ("Open the board", None)
        )

    def test_an_unsure_or_unlisted_detection_is_dropped(self):
        for info in (
            Mock(language="fr", language_probability=0.2),
            Mock(language="ko", language_probability=0.99),
            Mock(language="auto", language_probability=0.99),
            Mock(language="fr", language_probability="high"),
            None,
        ):
            model = Mock()
            model.transcribe.return_value = ([Mock(text="annyeong")], info)
            self.assertEqual(
                transcribe_with_language(model, b"audio", "auto"), ("annyeong", None)
            )

    def test_silence_reports_no_language(self):
        model = Mock()
        model.transcribe.return_value = (
            [],
            Mock(language="en", language_probability=0.9),
        )
        self.assertEqual(transcribe_with_language(model, b"audio", "auto"), ("", None))

    def test_rejects_unknown_language(self):
        with self.assertRaises(ValueError):
            transcribe_audio(Mock(), b"audio", "invalid")


if __name__ == "__main__":
    unittest.main()

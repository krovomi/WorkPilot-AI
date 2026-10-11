"""Tests for the Voice Control runner's keyword classifier.

Commands are classified by keywords (``_classify_command``); no model is
called. This file pins that classifier — a pure function on transcripts.
"""

from __future__ import annotations

import json

import pytest
from runners.voice_control_runner import VoiceControlProcessor


@pytest.fixture
def processor() -> VoiceControlProcessor:
    # model_id / thinking_budget are required by the constructor but unused
    # by the deterministic code paths under test. setup_client() either
    # initialises a real client (no token needed for that part) or logs a
    # warning — either way the instance is usable for the methods below.
    return VoiceControlProcessor(model_id="ignored", thinking_budget=0)


# ---------------------------------------------------------------------------
# _classify_command — keyword router


class TestClassifyCommand:
    @pytest.mark.parametrize(
        "transcript,expected_destination",
        [
            ("Show me the kanban board", "kanban"),
            ("Open the terminal view", "terminals"),
            ("Show me the analytics dashboard", "analytics"),
            ("Open the project settings", "settings"),
            ("Navigate to the code review", "code-review"),
            ("Open the documentation", "documentation"),
        ],
    )
    def test_english_navigation_phrases_route_correctly(
        self,
        processor: VoiceControlProcessor,
        transcript: str,
        expected_destination: str,
    ) -> None:
        result = processor._classify_command(transcript)
        assert result["action"] == "navigate"
        assert result["parameters"]["destination"] == expected_destination
        assert result["confidence"] >= 0.75

    @pytest.mark.parametrize(
        "transcript,expected_destination",
        [
            ("Ouvre le tableau de tâches", "kanban"),
            ("Va dans les paramètres", "settings"),
            ("Montre-moi les statistiques", "analytics"),
            ("Affiche la documentation", "documentation"),
        ],
    )
    def test_french_navigation_phrases_route_correctly(
        self,
        processor: VoiceControlProcessor,
        transcript: str,
        expected_destination: str,
    ) -> None:
        result = processor._classify_command(transcript)
        assert result["action"] == "navigate"
        assert result["parameters"]["destination"] == expected_destination

    def test_navigation_verb_boosts_confidence(
        self, processor: VoiceControlProcessor
    ) -> None:
        with_verb = processor._classify_command("Open the kanban board")
        bare = processor._classify_command("kanban")
        assert with_verb["confidence"] == 0.9
        assert bare["confidence"] == 0.75

    def test_unrecognised_command_returns_unknown(
        self, processor: VoiceControlProcessor
    ) -> None:
        result = processor._classify_command("Tell me a joke about quantum physics")
        assert result["action"] == "unknown"
        assert result["parameters"] == {}
        assert result["confidence"] == 0.3

    def test_transcript_preserved_verbatim(
        self, processor: VoiceControlProcessor
    ) -> None:
        original = "Show me the KaNbAn board NOW"
        result = processor._classify_command(original)
        # Original casing kept in transcript/command, lowered only for matching.
        assert result["transcript"] == original
        assert result["command"] == original

    def test_empty_transcript_is_unknown(
        self, processor: VoiceControlProcessor
    ) -> None:
        result = processor._classify_command("")
        assert result["action"] == "unknown"
        assert result["confidence"] == 0.3

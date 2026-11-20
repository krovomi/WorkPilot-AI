"""Labels read off a screen, compared, and matched to a mockup, at their edges.

The visual QA and screen tests cover the usual flow. This file covers what the
flow rarely meets: a label that is all punctuation, the same label twice, a
toolbar with nothing on it, two pairings that want the same label, a mockup
label that normalises to nothing, and a Figma export of another shape.
"""

from __future__ import annotations

import json

import pytest
from docintel.engines.base import OcrBox
from docintel.labels import (
    LabelDiff,
    diff_labels,
    labels_from_boxes,
    labels_from_text,
    levenshtein,
    load_figma,
    match_mockup,
    readable,
    similarity,
)


class TestDistances:
    def test_equal_strings_are_zero_apart(self):
        assert levenshtein("save", "save") == 0

    def test_two_empty_labels_are_the_same_and_one_empty_is_nothing_alike(self):
        assert similarity("", "!!") == 1.0
        assert similarity("Save", "") == 0.0


class TestReadingLabels:
    @pytest.mark.parametrize("text", ["", "   ", "x" * 121])
    def test_empty_or_overlong_text_is_no_label(self, text):
        assert not readable(text)

    def test_the_same_label_twice_and_noise_are_kept_once(self):
        assert labels_from_text("Save\nSAVE\n----\n\nCancel") == ["Save", "Cancel"]

    def test_a_toolbar_with_no_words_has_no_labels(self):
        assert labels_from_boxes([OcrBox(" ", 0, 0, 5, 5)]) == []


class TestDiff:
    def test_no_change_is_an_empty_diff(self):
        assert LabelDiff().empty
        assert diff_labels(["Save"], ["save"]).empty

    def test_a_label_two_pairings_want_goes_to_the_closest(self):
        diff = diff_labels(["Export now", "Export all"], ["Export file"])

        assert [(c.before, c.after) for c in diff.changed] == [
            ("Export all", "Export file")
        ]
        assert diff.removed == ["Export now"]


class TestMockup:
    def test_a_mockup_label_that_normalises_to_nothing_is_not_counted(self):
        match = match_mockup(["Checkout", "---"], ["Checkout"])

        assert (match.matched, match.total, match.coverage) == (1, 1, 1.0)


class TestFigmaExport:
    def test_a_file_that_is_no_json_is_no_mockup(self, tmp_path):
        path = tmp_path / "screen.figma.json"
        path.write_text("{broken", encoding="utf-8")

        assert load_figma(path) is None

    def test_frames_of_another_shape_are_skipped(self, tmp_path):
        path = tmp_path / "screen.figma.json"
        path.write_text(
            json.dumps(
                {
                    "source": "figma",
                    "file_key": "k",
                    "frames": [
                        "not a frame",
                        {"id": "1", "texts": "Checkout"},
                        {"id": "2", "name": "Cart", "texts": ["Pay", 3, "Pay", ""]},
                    ],
                }
            ),
            encoding="utf-8",
        )

        mockup = load_figma(path)

        assert [(f.id, f.texts) for f in mockup.frames] == [("2", ["Pay"])]

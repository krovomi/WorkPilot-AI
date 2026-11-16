"""The report the correcting model reads, and the edits it answers."""

from __future__ import annotations

import json

import pytest
from design_to_code.diff import Box, DiffReport, RegionDiff
from design_to_code.feedback import (
    MAX_EDITS,
    MAX_FILES_CHARS,
    PREVIEW_PATH,
    Edit,
    apply_edits,
    build_feedback,
    build_prompt,
    describe,
    parse_answer,
)


def _report() -> DiffReport:
    good = RegionDiff(
        "Footer", Box(0, 200, 400, 100), 1.0, 1.0, 1.0, "#ffffff", "#ffffff"
    )
    bad = RegionDiff(
        "Header",
        Box(0, 0, 400, 80),
        0.2,
        0.9,
        0.55,
        "#e63946",
        "#f08030",
        issues=[{"kind": "color", "target": "#e63946", "render": "#f08030"}],
    )
    worse = RegionDiff(
        "Card",
        Box(0, 80, 400, 120),
        0.1,
        0.5,
        0.3,
        "#ffffff",
        "#ffffff",
        issues=[{"kind": "offset", "axis": "y", "px": 12}],
    )
    return DiffReport(400, 300, 0.5, 0.8, 0.65, 0.1, [good, bad, worse], b"")


@pytest.mark.parametrize(
    ("issue", "sentence"),
    [
        (
            {"kind": "color", "target": "#e63946", "render": "#f08030"},
            "background is #f08030 but should be #e63946",
        ),
        (
            {"kind": "offset", "axis": "y", "px": 12},
            "content sits 12px lower than in the target",
        ),
        (
            {"kind": "offset", "axis": "y", "px": -3},
            "content sits 3px higher than in the target",
        ),
        (
            {"kind": "offset", "axis": "x", "px": 5},
            "content sits 5px further right than in the target",
        ),
        (
            {"kind": "offset", "axis": "x", "px": -5},
            "content sits 5px further left than in the target",
        ),
        (
            {"kind": "size", "axis": "width", "px": 8},
            "content is 8px wider than in the target",
        ),
        (
            {"kind": "size", "axis": "height", "px": -8},
            "content is 8px shorter than in the target",
        ),
        (
            {"kind": "structure"},
            "layout or shapes differ; no single colour, offset or size explains it",
        ),
    ],
)
def test_each_difference_reads_as_one_neutral_sentence(issue, sentence) -> None:
    assert describe(issue) == sentence


def test_the_feedback_lists_failing_regions_worst_first() -> None:
    feedback = build_feedback(_report(), iteration=2, threshold=0.95)
    assert [r["name"] for r in feedback["regions"]] == ["Card", "Header"]
    assert feedback["regions"][0]["differences"][0]["message"].startswith(
        "content sits 12px"
    )
    assert feedback["size"] == {"width": 400, "height": 300}
    assert feedback["iteration"] == 2 and feedback["ignored_share"] == 0.1


def test_the_prompt_carries_the_report_the_files_and_the_mirror_note() -> None:
    feedback = build_feedback(_report(), iteration=1, threshold=0.95)
    files = {"src/Card.tsx": "export const Card = () => null;"}
    plain = build_prompt(feedback, files, stack_label="React", mirror=False)
    assert "{{" not in plain and PREVIEW_PATH not in plain
    assert json.dumps(feedback, indent=2) in plain
    assert "<<<FILE src/Card.tsx>>>\nexport const Card" in plain
    mirrored = build_prompt(feedback, files, stack_label="React", mirror=True)
    assert f"BOTH the React files and {PREVIEW_PATH}" in mirrored


def test_long_files_are_cut_and_say_so() -> None:
    feedback = build_feedback(_report(), iteration=1, threshold=0.95)
    files = {"a.html": "x" * (MAX_FILES_CHARS + 10), "b.css": "body{}"}
    prompt = build_prompt(feedback, files, stack_label="HTML", mirror=False)
    assert prompt.count("[... cut: the rest of the file is unchanged ...]") == 2


def test_an_answer_in_a_fence_is_read() -> None:
    raw = (
        "```json\n"
        + json.dumps(
            {
                "edits": [{"path": "a.html", "find": "red", "replace": "blue"}],
                "notes": ["colour", 3],
            }
        )
        + "\n```"
    )
    answer = parse_answer(raw)
    assert answer is not None
    assert answer.edits == [Edit("a.html", "red", "blue")] and answer.notes == [
        "colour"
    ]


@pytest.mark.parametrize(
    "raw", ["", "no json here", "{not json}", "[1, 2]", '{"edits": "nope"}', "} {"]
)
def test_an_answer_that_is_not_the_json_asked_for_is_none(raw) -> None:
    assert parse_answer(raw) is None


def test_malformed_or_oversized_edits_are_dropped_and_the_count_capped() -> None:
    edits = [
        {"path": "a", "find": "", "replace": "x"},
        {"path": "a", "find": "x", "replace": "y" * (64 * 1024 + 1)},
        {"path": 1, "find": "x", "replace": "y"},
        "not an edit",
    ] + [{"path": "a", "find": f"{i}", "replace": "z"} for i in range(MAX_EDITS + 5)]
    answer = parse_answer(json.dumps({"edits": edits}))
    assert answer is not None and answer.notes == []
    assert len(answer.edits) == MAX_EDITS - 4


def test_edits_apply_once_and_refusals_say_why() -> None:
    files = {"a.html": "<b>red</b> <i>x</i> <i>x</i>"}
    edits = [
        Edit("a.html", "red", "blue"),
        Edit("a.html", "missing", "y"),
        Edit("a.html", "<i>x</i>", "y"),
        Edit("../elsewhere", "x", "y"),
    ]
    result, applied, refused = apply_edits(files, edits)
    assert applied == 1 and result["a.html"].startswith("<b>blue</b>")
    assert files["a.html"].startswith("<b>red</b>")
    assert [r["reason"] for r in refused] == ["not_found", "ambiguous", "unknown_file"]

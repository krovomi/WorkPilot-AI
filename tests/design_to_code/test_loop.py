"""The loop's stopping rules, on a page drawn from its one file."""

from __future__ import annotations

import asyncio
import json

import numpy as np
import pytest
from design_to_code.diff import Box, Region
from design_to_code.loop import CorrectionError, LoopConfig, run_loop, serialize
from design_to_code.render import RenderError
from PIL import Image

TARGET = {"header": "#e63946", "top": 120}
REGIONS = [Region("Header", Box(0, 0, 400, 80)), Region("Card", Box(0, 80, 400, 220))]


def _draw(page: dict) -> Image.Image:
    pixels = np.full((300, 400, 3), 255, dtype=np.uint8)
    pixels[:80, :] = [int(page["header"][i : i + 2], 16) for i in (1, 3, 5)]
    pixels[page["top"] : page["top"] + 60, 40:240] = (29, 53, 87)
    return Image.fromarray(pixels)


def _files(**page) -> dict[str, str]:
    return {"index.html": json.dumps({**TARGET, **page})}


async def _render(files: dict[str, str]) -> Image.Image:
    return _draw(json.loads(files["index.html"]))


def _edit(old: str, new: str) -> str:
    return json.dumps(
        {"edits": [{"path": "index.html", "find": old, "replace": new}], "notes": ["n"]}
    )


def _corrector(*answers):
    """Answers in order; an exception instance is raised."""
    queue = list(answers)
    prompts: list[str] = []

    async def correct(prompt: str, png: bytes) -> str:
        prompts.append(prompt)
        assert png.startswith(b"\x89PNG")
        answer = queue.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer

    correct.prompts = prompts  # type: ignore[attr-defined]
    return correct


def _run(files, correct, *, render=_render, **config):
    events: list[dict] = []
    outcome = asyncio.run(
        run_loop(
            _draw(TARGET),
            files,
            render=render,
            correct=correct,
            regions=REGIONS,
            masks=[],
            stack_label="HTML",
            mirror=False,
            config=LoopConfig(**config) if config else None,
            on_progress=events.append,
        )
    )
    return outcome, events


def test_a_correction_that_fixes_the_colour_converges_and_keeps_its_files() -> None:
    correct = _corrector(_edit("#f08030", "#e63946"))
    outcome, events = _run(_files(header="#f08030"), correct)
    assert outcome.status == "converged" and outcome.best_index == 1
    assert json.loads(outcome.files["index.html"])["header"] == "#e63946"
    assert [it.applied_edits for it in outcome.iterations] == [0, 1]
    assert [e["stage"] for e in events] == ["render", "correct", "render"]
    assert events[0]["score"] is None and events[1]["score"] < 0.95
    [issue] = outcome.issues
    assert issue["status"] == "resolved" and issue["resolved_at"] == 1
    assert "background is #f08030 but should be #e63946" in correct.prompts[0]


def test_a_design_already_matched_asks_nothing() -> None:
    outcome, _ = _run(_files(), _corrector())
    assert outcome.status == "converged" and len(outcome.iterations) == 1


def test_the_loop_stops_at_its_iteration_cap_and_abandons_what_is_left() -> None:
    correct = _corrector(
        _edit('"top": 160', '"top": 150'), _edit('"top": 150', '"top": 140')
    )
    outcome, _ = _run(_files(top=160), correct, max_iterations=2, threshold=0.999)
    assert outcome.status == "max_iterations" and outcome.best_index == 2
    assert {i["status"] for i in outcome.issues} == {"abandoned"}


def test_a_last_correction_that_reaches_the_threshold_converges() -> None:
    outcome, _ = _run(
        _files(header="#f08030"),
        _corrector(_edit("#f08030", "#e63946")),
        max_iterations=1,
    )
    assert outcome.status == "converged"


def test_answers_that_change_nothing_stall_the_loop() -> None:
    correct = _corrector("I cannot help", _edit("absent", "x"))
    outcome, _ = _run(_files(header="#f08030"), correct)
    assert outcome.status == "stalled" and outcome.best_index == 0
    assert outcome.iterations[1].refused_edits == [
        {"path": "", "reason": "unreadable_answer"}
    ]
    assert outcome.iterations[2].refused_edits == [
        {"path": "index.html", "reason": "not_found"}
    ]
    assert {i["status"] for i in outcome.issues} == {"abandoned"}


def test_a_small_gain_that_reaches_the_threshold_is_not_a_stall() -> None:
    outcome, _ = _run(
        _files(header="#f08030"),
        _corrector(_edit("#f08030", "#e63946")),
        min_gain=0.9,
        patience=1,
    )
    assert outcome.status == "converged"


def test_a_worse_version_is_not_delivered() -> None:
    correct = _corrector(
        _edit('"top": 130', '"top": 200'), _edit('"top": 200', '"top": 210')
    )
    outcome, _ = _run(_files(top=130), correct, threshold=0.999)
    assert outcome.status == "stalled" and outcome.best_index == 0
    assert json.loads(outcome.files["index.html"])["top"] == 130


def test_an_issue_resolved_stays_resolved_and_one_that_comes_back_reopens() -> None:
    correct = _corrector(
        _edit("#f08030", "#e63946"),
        _edit('"top": 160', '"top": 150'),
        _edit("#e63946", "#000000"),
    )
    outcome, _ = _run(
        _files(header="#f08030", top=160),
        correct,
        max_iterations=3,
        threshold=0.999,
        min_gain=0,
    )
    header = next(i for i in outcome.issues if i["region"] == "Header")
    assert header["status"] == "abandoned" and header["last_seen"] == 3


def test_the_time_budget_stops_before_the_next_correction() -> None:
    ticks = iter([0.0, 1.0] + [1000.0] * 10)

    async def scenario():
        return await run_loop(
            _draw(TARGET),
            _files(header="#f08030"),
            render=_render,
            correct=_corrector(),
            regions=REGIONS,
            masks=[],
            stack_label="HTML",
            mirror=False,
            config=LoopConfig(budget_seconds=60),
            clock=lambda: next(ticks),
        )

    assert asyncio.run(scenario()).status == "budget"


def test_a_failed_model_call_keeps_the_best_version() -> None:
    outcome, _ = _run(
        _files(header="#f08030"),
        _corrector(CorrectionError("provider answered HTTP 500")),
    )
    assert outcome.status == "failed" and outcome.detail == "provider answered HTTP 500"
    assert outcome.files == _files(header="#f08030")


def test_a_capture_that_fails_ends_the_loop() -> None:
    async def broken(files):
        raise RenderError("load_failed")

    outcome, _ = _run(_files(), _corrector(), render=broken)
    assert (
        outcome.status == "failed"
        and outcome.detail == "load_failed"
        and outcome.iterations == []
    )

    calls = {"n": 0}

    async def second_fails(files):
        calls["n"] += 1
        if calls["n"] == 2:
            raise RenderError("load_failed")
        return await _render(files)

    outcome, _ = _run(
        _files(header="#f08030"),
        _corrector(_edit("#f08030", "#e63946")),
        render=second_fails,
    )
    assert outcome.status == "failed" and len(outcome.iterations) == 1


def test_without_a_progress_callback_the_loop_still_runs() -> None:
    outcome = asyncio.run(
        run_loop(
            _draw(TARGET),
            _files(),
            render=_render,
            correct=_corrector(),
            regions=REGIONS,
            masks=[],
            stack_label="HTML",
            mirror=True,
        )
    )
    assert outcome.status == "converged"


def test_the_outcome_reads_as_the_page_expects() -> None:
    outcome, _ = _run(_files(header="#f08030"), _corrector(_edit("#f08030", "#e63946")))
    data = serialize(outcome, threshold=0.95, mirror=False, extra={"route": "ollama"})
    assert data["status"] == "converged" and data["route"] == "ollama"
    assert data["iterations"][0]["render_image"].startswith("data:image/png;base64,")
    assert data["iterations"][1]["notes"] == ["n"]
    assert json.dumps(data)


@pytest.mark.parametrize("field", ["max_iterations", "threshold"])
def test_the_defaults_are_the_issues(field) -> None:
    assert {"max_iterations": 5, "threshold": 0.95}[field] == getattr(
        LoopConfig(), field
    )

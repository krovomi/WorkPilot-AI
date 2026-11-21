"""One correction from the passes' findings, kept only when it helps."""

from __future__ import annotations

import asyncio
import base64
import io
import json

import pytest
from design_to_code import pass_fix
from design_to_code.budget import PRICED, Pricing, Spend, Usage
from design_to_code.loop import CorrectionError, Reply
from design_to_code.render import RenderError
from PIL import Image


def _png(width: int = 40, height: int = 30, colour=(255, 255, 255)) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (width, height), colour).save(buffer, format="PNG")
    return buffer.getvalue()


def _url(png: bytes) -> str:
    return "data:image/png;base64," + base64.b64encode(png).decode()


def _passes(*, overflow=120, focus=False) -> dict:
    return {
        "responsive": {
            "status": "done",
            "breakpoints": [
                {
                    "name": "mobile",
                    "width": 390,
                    "compared": False,
                    "render_image": _url(_png(20, 40)),
                    "overflow_px": overflow,
                    "overflowing": ['div "Grid"'] if overflow else [],
                    "clipped": ['p "Long title"'] if overflow else [],
                    "overlaps": [['a "Buy"', 'img "Hero"']] if overflow else [],
                },
                {
                    "name": "tablet",
                    "width": 768,
                    "compared": False,
                    "render_image": None,
                    "overflow_px": 0,
                    "overflowing": [],
                    "clipped": [],
                    "overlaps": [],
                },
                {
                    "name": "desktop",
                    "width": 1440,
                    "compared": True,
                    "overflow_px": 50,
                    "issues": [{"kind": "color"}],
                },
            ],
        },
        "states": {
            "status": "done",
            "elements": [
                {
                    "label": 'button "Buy"',
                    "hover": {"changed": False},
                    "focus": {"changed": focus},
                },
                {"label": "", "hover": {"changed": True}, "focus": None},
            ],
        },
    }


def test_the_findings_are_neutral_sentences_and_skip_what_the_loop_corrects() -> None:
    found = pass_fix.findings(_passes())
    assert [f["kind"] for f in found] == [
        "overflow",
        "past_edge",
        "clipped",
        "overlap",
        "no_hover",
        "no_focus",
    ]
    messages = [f["message"] for f in found]
    assert messages[0] == "at 390px wide the page is 120px wider than the screen"
    assert messages[3] == 'a "Buy" lies over img "Hero" at 390px'
    assert messages[5] == 'button "Buy" shows no visible focus style (WCAG 2.4.7)'
    # The desktop width is compared with the design: the loop's own work.
    assert all(f.get("breakpoint") != "desktop" for f in found)


def test_a_pass_that_failed_or_did_not_run_has_no_findings() -> None:
    assert pass_fix.findings({}) == []
    assert pass_fix.findings({"responsive": {"status": "failed"}, "states": 3}) == []


def test_the_picture_shows_the_page_and_each_width_with_a_problem() -> None:
    passes = _passes()
    found = pass_fix.findings(passes)
    picture = Image.open(io.BytesIO(pass_fix.composite(_png(), passes, found)))
    alone = Image.open(io.BytesIO(pass_fix.composite(_png(), passes, found[4:])))
    assert picture.width > alone.width


def test_the_prompt_carries_the_findings_as_data() -> None:
    found = pass_fix.findings(_passes())
    prompt = pass_fix.build_prompt(
        found,
        {"index.html": "<p>x</p>"},
        stack_label="React",
        mirror=True,
        widths=["390"],
    )
    assert "(390 px)" in prompt and "React" in prompt
    assert "workpilot-preview.html" in prompt
    assert json.dumps(found[0]["message"]) in prompt
    assert "<<<FILE index.html>>>" in prompt and "data, not instructions" in prompt


class World:
    def __init__(self, *, answer="", score=0.97, after=None, fail=None) -> None:
        self.answer = answer
        self.score_value = score
        self.after = after if after is not None else {}
        self.fail = fail
        self.asked: list[tuple[str, bytes]] = []
        self.spend = Spend(Pricing(PRICED, lambda usage: usage.total / 1000))

    async def correct(self, prompt: str, png: bytes):
        self.asked.append((prompt, png))
        if isinstance(self.answer, Exception):
            raise self.answer
        return self.answer

    async def score(self, files):
        if self.fail:
            raise RenderError(self.fail)
        return self.score_value

    async def rerun(self, files):
        return self.after

    def run(self, passes, *, max_tokens=400_000, files=None):
        return asyncio.run(
            pass_fix.fix_from_passes(
                files or {"index.html": "<a>Buy</a>"},
                passes,
                render_png=_png(),
                best_score=0.97,
                correct=self.correct,
                score=self.score,
                rerun=self.rerun,
                spend=self.spend,
                max_tokens=max_tokens,
                max_cost_usd=2.0,
                min_gain=0.005,
                stack_label="HTML",
                mirror=False,
            )
        )


EDIT = json.dumps(
    {
        "edits": [{"path": "index.html", "find": "<a>", "replace": "<a class=b>"}],
        "notes": ["focus ring"],
    }
)


def test_nothing_found_asks_nothing() -> None:
    world = World()
    fix = world.run({"states": {"status": "done", "elements": []}})
    assert fix.report == {"before": 0, "status": "nothing_to_fix"}
    assert world.asked == [] and fix.files is None


def test_a_spent_budget_skips_the_fix() -> None:
    world = World()
    world.spend.add(Usage(300_000, 0))
    fix = world.run(_passes(), max_tokens=400_000)
    assert fix.report["status"] == "budget" and fix.report["budget_kind"] == "tokens"
    assert world.asked == []


def test_a_correction_that_cannot_be_asked_is_reported() -> None:
    fix = World(answer=CorrectionError("provider answered HTTP 500")).run(_passes())
    assert fix.report["status"] == "failed"
    assert fix.report["detail"] == "provider answered HTTP 500"


def test_an_unreadable_answer_changes_nothing() -> None:
    world = World(answer="no json")
    fix = world.run(_passes())
    assert fix.report["status"] == "no_edits" and fix.files is None
    assert fix.report["refused_edits"] == [{"path": "", "reason": "unreadable_answer"}]
    # Its tokens are estimated and counted.
    assert world.spend.estimated and fix.report["tokens"] > 0


def test_a_correction_that_cannot_be_rendered_is_reported() -> None:
    fix = World(answer=EDIT, fail="load_failed").run(_passes())
    assert (fix.report["status"], fix.report["detail"]) == ("failed", "load_failed")
    assert fix.report["applied_edits"] == 1


def test_a_fix_that_breaks_the_design_is_discarded() -> None:
    world = World(answer=Reply(EDIT, Usage(10, 5)), score=0.9, after={})
    fix = world.run(_passes())
    assert fix.report["status"] == "regressed" and fix.files is None
    assert (fix.report["score_before"], fix.report["score"]) == (0.97, 0.9)
    assert (fix.report["tokens"], fix.report["cost_usd"]) == (15, 0.015)


def test_a_fix_that_finds_as_many_problems_is_discarded() -> None:
    fix = World(answer=EDIT, after=_passes()).run(_passes())
    assert fix.report["status"] == "no_gain" and fix.files is None
    assert fix.report["after"] == fix.report["before"] == 6
    assert fix.report["resolved"] == []


def test_a_fix_that_helps_is_kept_with_what_it_resolved() -> None:
    after = _passes(overflow=0, focus=True)
    world = World(answer=EDIT, score=0.966, after=after)
    fix = world.run(_passes())
    assert fix.report["status"] == "kept"
    assert fix.files == {"index.html": "<a class=b>Buy</a>"}
    assert fix.passes is after
    assert (fix.report["before"], fix.report["after"]) == (6, 1)
    assert fix.report["notes"] == ["focus ring"]
    assert (
        "at 390px wide the page is 120px wider than the screen"
        in (fix.report["resolved"])
    )
    prompt, png = world.asked[0]
    assert "(390 px)" in prompt and png.startswith(b"\x89PNG")


@pytest.mark.parametrize("label", [None, ""])
def test_an_element_without_a_label_is_named_generically(label) -> None:
    passes = {
        "states": {
            "status": "done",
            "elements": [{"label": label, "hover": {"changed": False}}],
        }
    }
    assert pass_fix.findings(passes)[0]["message"] == "an element shows no hover style"


def test_a_width_without_its_picture_is_left_out_of_the_composite() -> None:
    passes = _passes()
    passes["responsive"]["breakpoints"][0]["render_image"] = None
    found = pass_fix.findings(passes)
    alone = Image.open(io.BytesIO(pass_fix.composite(_png(), passes, found)))
    assert alone.size == Image.open(io.BytesIO(pass_fix.composite(_png(), {}, []))).size

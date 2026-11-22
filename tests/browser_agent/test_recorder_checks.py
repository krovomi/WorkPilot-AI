"""Lot 3 of the recorder: selectors that are not unique, loading indicators a
replay waits to see gone, and checks proposed after an action.

Each is observed on the page and arrives as page data: the counts, what a
loading indicator has and the texts that showed up are bounded and checked
here before they reach a step, and a proposed check stays out of the
recording until the person keeps it.
"""

from __future__ import annotations

import pytest
from browser_agent.codegen import export_recording
from browser_agent.codegen_webdriver import webdriver_locator
from browser_agent.recorder import (
    MAX_SUGGESTIONS,
    SETTLE_WINDOW_S,
    SUGGEST_WINDOW_S,
    SUGGESTIONS_PER_ACTION,
    Recorder,
    loader_css,
)
from browser_agent.recording import (
    MAX_MATCHES,
    RecordedStep,
    Recording,
    Selector,
    is_place,
    loader_selector,
)
from browser_agent.selector_builder import build_selectors, place

ADD = {
    "tag": "button",
    "role": "button",
    "name": "Add",
    "text": "Add",
    "path": "li:nth-of-type(2) > button",
    "id": "add-pear",
    "idUnique": True,
    "matches": {"role": {"count": 3, "index": 1}, "text": {"count": 3, "index": 1}},
}
SAVE = {"tag": "button", "role": "button", "name": "Save", "text": "Save"}
SAVED = {"tag": "div", "text": "Saved!", "path": "div:nth-of-type(2)"}


class Clock:
    def __init__(self) -> None:
        self.now = 100.0

    def __call__(self) -> float:
        return self.now


# --- Selectors that match several elements -----------------------------------------


@pytest.mark.parametrize(
    ("counted", "expected"),
    [
        (None, (True, None)),
        ("3", (True, None)),
        ({"count": 1, "index": 0}, (True, None)),
        ({"count": 3, "index": 2}, (True, 2)),
        ({"count": 3, "index": 3}, (False, None)),
        ({"count": 3, "index": -1}, (False, None)),
        ({"count": 3, "index": True}, (False, None)),
        ({"count": 3}, (False, None)),
        ({"count": MAX_MATCHES + 1, "index": 0}, (False, None)),
        ({"count": 0, "index": 0}, (False, None)),
        ({"count": True, "index": 0}, (False, None)),
        ({"count": "2", "index": 0}, (False, None)),
    ],
)
def test_a_count_from_the_page_keeps_drops_or_places_a_selector(
    counted: object, expected: tuple[bool, int | None]
) -> None:
    matches = None if counted is None else {"role": counted}
    assert place({"matches": matches}, "role") == expected
    if counted is None:
        assert place({"matches": {"text": counted}}, "role") == expected


def test_a_selector_that_is_not_unique_moves_after_the_stable_css() -> None:
    assert build_selectors(ADD) == [
        Selector("css", "#add-pear"),
        Selector("role", "Add", "button", 1),
        Selector("text", "Add", nth=1),
        Selector("css", "li:nth-of-type(2) > button"),
    ]
    # A unique one stays first; one matching too many is not kept at all.
    unique = {**ADD, "matches": {"role": {"count": 1, "index": 0}}}
    assert build_selectors(unique)[0] == Selector("role", "Add", "button")
    crowded = {**ADD, "matches": {"role": {"count": 50, "index": 1}}}
    assert Selector("role", "Add", "button") not in build_selectors(crowded)
    assert all(s.strategy != "role" for s in build_selectors(crowded))


def test_a_place_reads_back_only_as_a_small_integer() -> None:
    placed = Selector("role", "Add", "button", 2)
    assert placed.to_dict() == {
        "strategy": "role",
        "value": "Add",
        "role": "button",
        "nth": 2,
    }
    assert Selector.from_dict(placed.to_dict()) == placed
    assert Selector.from_dict({"strategy": "text", "value": "Add", "nth": 0}) == (
        Selector("text", "Add", nth=0)
    )
    for bad in (-1, MAX_MATCHES, True, 1.0, "1"):
        assert (
            Selector.from_dict({"strategy": "text", "value": "A", "nth": bad}) is None
        )
    assert is_place(0) and not is_place(False)


# --- Loading indicators ------------------------------------------------------------


@pytest.mark.parametrize(
    ("loader", "css"),
    [
        ({"testId": 'load"ing'}, '[data-testid="load\\"ing"]'),
        ({"id": "page-loader"}, "#page-loader"),
        ({"id": "ld-a1b2c3d4", "role": "progressbar"}, '[role="progressbar"]'),
        ({"busy": True, "className": "spinner"}, '[aria-busy="true"]'),
        ({"className": "card is-loading big"}, ".is-loading"),
        ({"className": "card big"}, ""),
        ({"className": "x}{y-loading"}, ""),
        ({"busy": "true"}, ""),
        ("spinner", ""),
    ],
)
def test_a_loader_selector_is_built_from_closed_patterns(
    loader: object, css: str
) -> None:
    assert loader_css(loader) == css
    assert loader_selector(css) == css


def test_a_loader_selector_from_json_is_one_of_those_patterns() -> None:
    for hostile in ("div > .spinner", '[onclick="x"]', ".a, body", "#a b", 3):
        assert loader_selector(hostile) == ""
    assert loader_selector("." + "a" * 400) == ""


def test_a_loader_gone_soon_after_an_action_is_what_it_waits_for() -> None:
    clock = Clock()
    rec = Recorder(clock)
    settled = {"kind": "settled", "loader": {"className": "spinner"}}
    assert rec.on_page_event(settled) is None  # no action yet
    click = rec.on_page_event({"kind": "click", "target": ADD})
    assert rec.on_page_event(settled, ["#frame"]) is None  # not the top page
    assert rec.on_page_event({"kind": "settled", "loader": {}}) is None
    clock.now += SETTLE_WINDOW_S - 1
    assert rec.on_page_event(settled) is click and click.wait_hidden == ".spinner"
    # The first loader stays the one waited for.
    other = {"kind": "settled", "loader": {"role": "progressbar"}}
    assert rec.on_page_event(other) is None and click.wait_hidden == ".spinner"
    assert click.to_dict()["waitHidden"] == ".spinner"
    late = rec.on_page_event({"kind": "click", "target": SAVE})
    clock.now += SETTLE_WINDOW_S + 1
    assert rec.on_page_event(settled) is None and late.wait_hidden == ""
    back = RecordedStep.from_dict({**click.to_dict(), "waitHidden": "body *"})
    assert back is not None and back.wait_hidden == ""


# --- Proposed checks ---------------------------------------------------------------


def _suggest(text: str, target: object = SAVED) -> dict[str, object]:
    return {"kind": "suggest", "target": target, "text": text}


def test_what_showed_up_after_an_action_is_proposed_not_recorded() -> None:
    clock = Clock()
    rec = Recorder(clock)
    rec.start("http://localhost:3000/")
    assert rec.on_page_event(_suggest("Shop")) is None  # nothing caused it
    click = rec.on_page_event({"kind": "click", "target": SAVE})
    proposed = rec.on_page_event(_suggest("Saved!"))
    assert proposed is not None and proposed.kind == "assert_text"
    assert proposed.after == click.id and proposed.text == "Saved!"
    assert proposed.to_dict()["after"] == click.id
    assert [s.id for s in rec.steps] == ["s1", click.id]
    assert rec.on_page_event(_suggest("Saved!")) is None  # the same text again
    assert rec.on_page_event(_suggest("token sk-ant-api03-" + "a" * 40)) is None
    assert rec.on_page_event(_suggest("")) is None
    assert rec.on_page_event({"kind": "suggest", "target": "x", "text": "A"}) is None
    for n in range(SUGGESTIONS_PER_ACTION):
        rec.on_page_event(_suggest(f"line {n}"))
    assert rec.suggestions == SUGGESTIONS_PER_ACTION
    clock.now += 1
    rec.on_page_event({"kind": "click", "target": ADD})
    clock.now += SUGGEST_WINDOW_S + 1
    assert rec.on_page_event(_suggest("Too late")) is None
    # Read back for an export, a kept check is a plain text check.
    back = RecordedStep.from_dict(proposed.to_dict())
    assert back is not None and back.after == "" and back.text == "Saved!"


def test_proposed_checks_stop_at_their_cap() -> None:
    clock = Clock()
    rec = Recorder(clock)
    rec.suggestions = MAX_SUGGESTIONS
    rec.on_page_event({"kind": "click", "target": SAVE})
    assert rec.on_page_event(_suggest("Saved!")) is None


# --- Exports -----------------------------------------------------------------------


def _steps() -> Recording:
    return Recording(
        steps=[
            RecordedStep("s1", "navigate", url="http://localhost:3000/"),
            RecordedStep(
                "s2",
                "click",
                [
                    Selector("role", "Add", "button", 1),
                    Selector("css", "li:nth-of-type(2) > button"),
                ],
                wait_hidden=".spinner",
            ),
            RecordedStep(
                "s3",
                "fill",
                [Selector("placeholder", "Qty", nth=2), Selector("css", "#qty")],
                value="3",
            ),
            RecordedStep(
                "s4",
                "assert_text",
                [Selector("text", "Added", nth=0), Selector("css", "#live")],
                text="Added",
            ),
        ]
    )


def test_playwright_names_the_place_and_waits_for_the_loader() -> None:
    ts = export_recording(_steps(), "playwright-ts").code
    assert (
        'page.getByRole("button", { name: "Add", exact: true }).nth(1).click();' in ts
    )
    assert (
        'page.getByPlaceholder("Qty", { exact: true }).nth(2).fill(data["qty"]);' in ts
    )
    assert 'page.getByText("Added", { exact: true }).nth(0)' in ts
    assert (
        'await expect(page.locator(".spinner").locator("visible=true"))'
        ".toHaveCount(0);" in ts
    )
    py = export_recording(_steps(), "playwright-python").code
    assert 'page.get_by_role("button", name="Add", exact=True).nth(1).click()' in py
    assert (
        'expect(page.locator(".spinner").locator("visible=true")).to_have_count(0)'
        in py
    )


def test_cypress_picks_a_place_only_where_its_query_returns_them_all() -> None:
    cy = export_recording(_steps(), "cypress").code
    assert 'cy.get("li:nth-of-type(2) > button").click();' in cy
    assert 'cy.get("[placeholder=\\"Qty\\"]").eq(2).clear()' in cy
    assert 'cy.get("#live").should("contain.text", "Added");' in cy
    assert (
        'cy.get("body").should((body) => expect(body.find(".spinner")'
        '.filter(":visible")).to.have.length(0));' in cy
    )
    only = Recording(
        steps=[RecordedStep("s1", "click", [Selector("text", "A", nth=1)])]
    )
    assert export_recording(only, "cypress").skipped == 1


def test_webdriver_passes_a_place_over_and_waits_for_the_loader() -> None:
    assert webdriver_locator(Selector("testid", "a", nth=1)) is None
    py = export_recording(_steps(), "selenium-python").code
    assert 'locate(driver, By.CSS_SELECTOR, "li:nth-of-type(2) > button")' in py
    assert 'wait_for_hidden(driver, ".spinner")' in py
    assert "def wait_for_hidden(driver, css):" in py
    java = export_recording(_steps(), "selenium-java").code
    assert 'waitForHidden(".spinner");' in java
    assert "private void waitForHidden(String css) {" in java
    wdio = export_recording(_steps(), "webdriverio").code
    assert 'await waitForHidden(".spinner");' in wdio
    assert "async function waitForHidden(css) {" in wdio

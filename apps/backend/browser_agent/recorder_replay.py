"""Reshoot: replay a recording without a window, step by step, and see which
selectors still find their element (#387).

Each step is tried with its selectors in order, as the exports try them:

- ``ok``: the first selector still finds the element;
- ``changed``: only a later one does; the element is described again in the
  page, as the recorder describes it, and its new selectors are proposed;
- ``missing``: none does, so the replay stops there;
- ``failed``: the element is there but its action failed;
- ``not-reached``: a step after the one the replay stopped at.

The action is then done, so the page moves on to the next step as it did when
recorded, and a dialog is answered as it was. The page is someone else's code:
what it describes is read back through the same closed lists as a recording
(:func:`build_selectors`), and nothing the page says is run.
"""

from __future__ import annotations

import asyncio
import os
import time
from dataclasses import dataclass, field
from typing import Any

from playwright.async_api import Error as BrowserError

from .recorder import BINDING, DESCRIBE_FRAME, SCRIPT
from .recording import RecordedStep, Recording, Selector
from .selector_builder import build_selectors

STATUSES = ("ok", "changed", "missing", "failed", "not-reached")
#: How long a step's element is waited for.
FIND_TIMEOUT_S = 8.0
ACTION_TIMEOUT_MS = 8000
_POLL_S = 0.2


@dataclass
class ShotStep:
    """What the replay found for one step."""

    id: str
    status: str
    #: The selectors that find the element now (``changed`` only).
    selectors: list[Selector] = field(default_factory=list)

    def to_dict(self) -> dict[str, object]:
        data: dict[str, object] = {"id": self.id, "status": self.status}
        if self.selectors:
            data["selectors"] = [s.to_dict() for s in self.selectors]
        return data


def locator(page: Any, step: RecordedStep, selector: Selector) -> Any:
    """The Playwright locator of ``selector``, down the step's frames.

    Playwright's CSS goes through open shadow roots, so the hosts above the
    element (or above a frame) need no hop of their own.
    """
    scope = page
    for css in step.frames:
        scope = scope.frame_locator(css)
    value = selector.value
    if selector.strategy == "testid":
        found = scope.get_by_test_id(value)
    elif selector.strategy == "role":
        found = scope.get_by_role(selector.role, name=value, exact=True)
    elif selector.strategy == "label":
        found = scope.get_by_label(value, exact=True)
    elif selector.strategy == "placeholder":
        found = scope.get_by_placeholder(value, exact=True)
    elif selector.strategy == "text":
        found = scope.get_by_text(value, exact=True)
    else:
        found = scope.locator(value)
    return found.nth(selector.nth) if selector.nth is not None else found


async def _matches(found: Any, placed: bool) -> bool:
    count = await found.count()
    return count >= 1 if placed else count == 1


async def find(
    page: Any,
    step: RecordedStep,
    selectors: list[Selector],
    timeout: float | None = None,
) -> tuple[int, Any] | None:
    """The first of ``selectors`` that finds one element, and its locator."""
    deadline = time.monotonic() + (FIND_TIMEOUT_S if timeout is None else timeout)
    while True:
        for index, selector in enumerate(selectors):
            found = locator(page, step, selector)
            try:
                if await _matches(found, selector.nth is not None):
                    return index, found
            except BrowserError:
                continue
        if time.monotonic() >= deadline:
            return None
        await asyncio.sleep(_POLL_S)


async def described(found: Any) -> list[Selector]:
    """The element's selectors now, as the recorder would build them."""
    try:
        target = await found.evaluate(DESCRIBE_FRAME)
    except BrowserError:
        return []
    return build_selectors(target) if isinstance(target, dict) else []


async def act(page: Any, step: RecordedStep, found: Any) -> None:
    """Do the step's action on ``found`` (raises ``BrowserError`` when it fails)."""
    timeout = ACTION_TIMEOUT_MS
    if step.kind == "click":
        await found.click(timeout=timeout)
    elif step.kind == "hover":
        await found.hover(timeout=timeout)
    elif step.kind == "fill":
        # A secret is read from the environment, empty when it is not set.
        value = os.environ.get(step.secret_env, "") if step.secret_env else step.value
        await found.fill(value, timeout=timeout)
    elif step.kind == "select":
        await found.select_option(step.values or step.value, timeout=timeout)
    elif step.kind == "press":
        await found.press(step.key, timeout=timeout)
    elif step.kind == "scroll":
        await found.evaluate(
            "(el, [x, y]) => el.scrollTo(x, y)", [step.scroll_x, step.scroll_y]
        )


async def _drag(page: Any, step: RecordedStep, found: Any) -> bool:
    target = await find(page, step, step.drop)
    if target is None:
        return False
    await found.drag_to(target[1], timeout=ACTION_TIMEOUT_MS)
    return True


async def _settle(page: Any) -> None:
    try:
        await page.wait_for_load_state("load", timeout=ACTION_TIMEOUT_MS)
    except BrowserError:
        return


async def shoot_step(page: Any, step: RecordedStep) -> ShotStep:
    """Replay one step and say what it found."""
    if step.kind == "navigate":
        try:
            await page.goto(step.url, wait_until="load", timeout=ACTION_TIMEOUT_MS * 4)
        except BrowserError:
            return ShotStep(step.id, "failed")
        return ShotStep(step.id, "ok")
    if step.kind == "scroll" and not step.selectors:
        await page.evaluate(
            "([x, y]) => window.scrollTo(x, y)", [step.scroll_x, step.scroll_y]
        )
        return ShotStep(step.id, "ok")
    hit = await find(page, step, step.selectors)
    if hit is None:
        return ShotStep(step.id, "missing")
    index, found = hit
    shot = ShotStep(step.id, "ok")
    if index:
        fresh = await described(found)
        shot = ShotStep(step.id, "changed", fresh or step.selectors[index:])
    try:
        if step.kind == "drag" and not await _drag(page, step, found):
            return ShotStep(step.id, "missing")
        await act(page, step, found)
    except BrowserError:
        return ShotStep(step.id, "failed")
    await _settle(page)
    return shot


async def reshoot(page: Any, recording: Recording) -> list[ShotStep]:
    """Replay ``recording`` in ``page``; the steps after a miss are not reached."""
    current: dict[str, RecordedStep | None] = {"step": None}

    async def on_dialog(dialog: Any) -> None:
        step = current["step"]
        answer = step.dialog if step is not None else None
        try:
            if answer is not None and answer.accept:
                await dialog.accept(answer.text or None)
            else:
                await dialog.dismiss()
        except BrowserError:
            return

    await page.expose_binding(BINDING, lambda *_args: None)
    await page.add_init_script(SCRIPT.read_text(encoding="utf-8"))
    page.on("dialog", on_dialog)
    shots: list[ShotStep] = []
    stopped = False
    for step in recording.steps:
        if stopped:
            shots.append(ShotStep(step.id, "not-reached"))
            continue
        current["step"] = step
        shot = await shoot_step(page, step)
        shots.append(shot)
        stopped = shot.status in ("missing", "failed")
    return shots

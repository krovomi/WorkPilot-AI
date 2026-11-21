"""
A recording written out as a test: Playwright (TypeScript, Python), Cypress,
Selenium (Python, Java) or WebdriverIO.

Deterministic, no model. Every piece of page content (URL, label, text, typed
value, CSS) enters the code only as a string literal of the target language
(``codegen_text``): a quote, a backslash, a line break, ``${…}`` or
``{enter}`` in a page stays text and never becomes code, interpolation or a
key sequence (Cypress ``type`` is told not to parse ``{…}``). Page text never
goes into a comment.

A secret field reads its value from an environment variable whose name the
recorder built from ``[A-Z0-9_]`` only (``recording.ENV_NAME``); the generated
file names the variables it needs at its top.

Each framework takes the first selector of a step it can express: Cypress has
no role or label query without an extra library, so it falls through to the
placeholder, the text or the CSS; Selenium and WebdriverIO find by CSS or
XPath, and only by CSS inside a shadow root (``codegen_webdriver``). A step
none of its selectors fit is written as a ``step skipped`` comment, never
guessed. A selector that matches several elements names the element's place
among them (``nth``): Playwright writes ``.nth(i)``; Cypress ``.eq(i)`` on a
query that returns them all (``cy.contains`` returns one, so a role or a text
with a place falls through); WebDriver falls through to the next selector.

Where the element lives and what the action caused come from the recording:
each framework goes down the step's iframes and shadow hosts, and waits for
the element to show when it appeared after the previous action, for the
response to the request the action started, for the loading indicator it
showed to go, and for the page it led to. Nothing waits for a fixed time.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from .codegen_text import css_string, literal, pascal, py_literal, slug
from .codegen_webdriver import selenium_java, selenium_python, webdriverio
from .recording import ENV_NAME, RecordedStep, Recording, Selector

FORMATS = (
    "playwright-ts",
    "playwright-python",
    "cypress",
    "selenium-python",
    "selenium-java",
    "webdriverio",
)
DEFAULT_NAME = "recorded flow"
MAX_NAME = 80

#: Where each framework's tests usually live, the first that exists wins.
TEST_DIRS: dict[str, tuple[str, ...]] = {
    "playwright-ts": ("e2e", "tests/e2e", "tests"),
    "playwright-python": ("tests/e2e", "tests", "e2e"),
    "cypress": ("cypress/e2e", "cypress/integration", "cypress"),
    "selenium-python": ("tests/e2e", "tests", "e2e"),
    # The folder is the package the class declares (`package e2e;`).
    "selenium-java": ("src/test/java/e2e",),
    "webdriverio": ("test/specs", "e2e", "tests/e2e"),
}

#: Cypress has no role query: the CSS of the elements a role usually comes from.
_CYPRESS_ROLE_CSS = {
    "button": 'button, [role="button"], input[type="submit"], input[type="button"]',
    "link": 'a[href], [role="link"]',
    "heading": 'h1, h2, h3, h4, h5, h6, [role="heading"]',
    "tab": '[role="tab"]',
    "menuitem": '[role="menuitem"]',
    "option": 'option, [role="option"]',
}
_CYPRESS_KEYS = {"Enter": "{enter}", "Escape": "{esc}"}

__all__ = [
    "FORMATS",
    "GeneratedTest",
    "clean_name",
    "export_recording",
    "file_path",
    "literal",
]


def clean_name(raw: object) -> str:
    """The test's title: one line, at most :data:`MAX_NAME` characters."""
    if not isinstance(raw, str):
        return DEFAULT_NAME
    flat = re.sub(r"[\x00-\x1f\x7f]", "", re.sub(r"\s+", " ", raw)).strip()
    return flat[:MAX_NAME] or DEFAULT_NAME


@dataclass
class GeneratedTest:
    """A test file to propose, relative to the project root."""

    format: str
    code: str
    path: str
    env_vars: list[str] = field(default_factory=list)
    skipped: int = 0

    def to_dict(self) -> dict[str, object]:
        return {
            "format": self.format,
            "code": self.code,
            "path": self.path,
            "envVars": self.env_vars,
            "skipped": self.skipped,
        }


def file_path(fmt: str, name: str, root: Path | None = None) -> str:
    """The test file's path, under the project's own test folder when it has one."""
    folders = TEST_DIRS[fmt]
    folder = next(
        (f for f in folders if root is not None and (root / f).is_dir()), folders[0]
    )
    if fmt in ("playwright-python", "selenium-python"):
        return f"{folder}/test_{slug(name, '_')}.py"
    if fmt == "cypress":
        return f"{folder}/{slug(name, '-')}.cy.js"
    if fmt == "selenium-java":
        return f"{folder}/{pascal(name)}Test.java"
    if fmt == "webdriverio":
        return f"{folder}/{slug(name, '-')}.e2e.js"
    return f"{folder}/{slug(name, '-')}.spec.ts"


# --- Playwright, TypeScript ----------------------------------------------------


def _pw_ts_scope(step: RecordedStep) -> str:
    """``page``, then down the step's frames and shadow hosts."""
    scope = "page"
    for frame in step.frames:
        scope += f".frameLocator({literal(frame)})"
    for host in step.shadow:
        scope += f".locator({literal(host)})"
    return scope


def _nth(locator: str, s: Selector) -> str:
    """A Playwright locator narrowed to the element's place, when not unique."""
    return locator if s.nth is None else f"{locator}.nth({s.nth})"


def _pw_ts_locator(scope: str, s: Selector) -> str:
    return _nth(_pw_ts_query(scope, s), s)


def _pw_ts_query(scope: str, s: Selector) -> str:
    if s.strategy == "testid":
        return f"{scope}.getByTestId({literal(s.value)})"
    if s.strategy == "role":
        return (
            f"{scope}.getByRole({literal(s.role)}, "
            f"{{ name: {literal(s.value)}, exact: true }})"
        )
    if s.strategy == "label":
        return f"{scope}.getByLabel({literal(s.value)}, {{ exact: true }})"
    if s.strategy == "placeholder":
        return f"{scope}.getByPlaceholder({literal(s.value)}, {{ exact: true }})"
    if s.strategy == "text":
        return f"{scope}.getByText({literal(s.value)}, {{ exact: true }})"
    return f"{scope}.locator({literal(s.value)})"


def _pw_ts_action(step: RecordedStep, loc: str) -> str:
    if step.kind == "click":
        return f"await {loc}.click();"
    if step.kind in ("fill", "select"):
        method = "fill" if step.kind == "fill" else "selectOption"
        value = (
            f"secret({literal(step.secret_env)})"
            if step.secret_env
            else literal(step.value)
        )
        return f"await {loc}.{method}({value});"
    if step.kind == "press":
        return f"await {loc}.press({literal(step.key)});"
    return f"await expect({loc}).toContainText({literal(step.text)});"


def _pw_ts_step(step: RecordedStep) -> list[str]:
    if step.kind == "navigate":
        return [f"await page.goto({literal(step.url)});"]
    loc = _pw_ts_locator(_pw_ts_scope(step), step.selectors[0])
    lines = [f"await expect({loc}).toBeVisible();"] if step.wait_visible else []
    response = f"response{step.id.upper()}"
    if step.wait_request:
        lines.append(
            f"const {response} = page.waitForResponse((r) => "
            f"r.request().method() === {literal(step.wait_request.method)} && "
            f"new URL(r.url()).pathname === {literal(step.wait_request.path)});"
        )
    lines.append(_pw_ts_action(step, loc))
    if step.wait_request:
        lines.append(f"await {response};")
    if step.wait_hidden:
        lines.append(
            f"await expect(page.locator({literal(step.wait_hidden)})"
            '.locator("visible=true")).toHaveCount(0);'
        )
    if step.wait_url:
        lines.append(
            "await page.waitForURL((url) => url.href.split(/[?#]/)[0] === "
            f"{literal(step.wait_url)});"
        )
    return lines


def _playwright_ts(name: str, steps: list[RecordedStep], env: list[str]) -> str:
    lines = ['import { expect, test } from "@playwright/test";', ""]
    if env:
        lines += [
            "// Secrets are read from the environment: " + ", ".join(env) + ".",
            "function secret(name: string): string {",
            "\tconst value = process.env[name];",
            '\tif (!value) throw new Error("Set " + name + " to run this test");',
            "\treturn value;",
            "}",
            "",
        ]
    lines.append(f"test({literal(name)}, async ({{ page }}) => {{")
    lines += [f"\t{line}" for s in steps for line in _pw_ts_step(s)]
    lines.append("});")
    return "\n".join(lines) + "\n"


# --- Playwright, Python ----------------------------------------------------------


def _pw_py_scope(step: RecordedStep) -> str:
    scope = "page"
    for frame in step.frames:
        scope += f".frame_locator({py_literal(frame)})"
    for host in step.shadow:
        scope += f".locator({py_literal(host)})"
    return scope


def _pw_py_locator(scope: str, s: Selector) -> str:
    return _nth(_pw_py_query(scope, s), s)


def _pw_py_query(scope: str, s: Selector) -> str:
    q = py_literal
    if s.strategy == "testid":
        return f"{scope}.get_by_test_id({q(s.value)})"
    if s.strategy == "role":
        return f"{scope}.get_by_role({q(s.role)}, name={q(s.value)}, exact=True)"
    if s.strategy == "label":
        return f"{scope}.get_by_label({q(s.value)}, exact=True)"
    if s.strategy == "placeholder":
        return f"{scope}.get_by_placeholder({q(s.value)}, exact=True)"
    if s.strategy == "text":
        return f"{scope}.get_by_text({q(s.value)}, exact=True)"
    return f"{scope}.locator({q(s.value)})"


def _pw_py_action(step: RecordedStep, loc: str) -> str:
    if step.kind == "click":
        return f"{loc}.click()"
    if step.kind in ("fill", "select"):
        method = "fill" if step.kind == "fill" else "select_option"
        value = (
            f"os.environ[{py_literal(step.secret_env)}]"
            if step.secret_env
            else py_literal(step.value)
        )
        return f"{loc}.{method}({value})"
    if step.kind == "press":
        return f"{loc}.press({py_literal(step.key)})"
    return f"expect({loc}).to_contain_text({py_literal(step.text)})"


def _pw_py_step(step: RecordedStep) -> list[str]:
    if step.kind == "navigate":
        return [f"page.goto({py_literal(step.url)})"]
    loc = _pw_py_locator(_pw_py_scope(step), step.selectors[0])
    lines = [f"expect({loc}).to_be_visible()"] if step.wait_visible else []
    action = _pw_py_action(step, loc)
    if step.wait_request:
        lines += [
            "with page.expect_response(lambda r: "
            f"r.request.method == {py_literal(step.wait_request.method)} and "
            f"urlsplit(r.url).path == {py_literal(step.wait_request.path)}):",
            f"    {action}",
        ]
    else:
        lines.append(action)
    if step.wait_hidden:
        lines.append(
            f"expect(page.locator({py_literal(step.wait_hidden)})"
            '.locator("visible=true")).to_have_count(0)'
        )
    if step.wait_url:
        lines.append(
            'page.wait_for_url(lambda url: url.split("#")[0].split("?")[0] == '
            f"{py_literal(step.wait_url)})"
        )
    return lines


def _playwright_python(name: str, steps: list[RecordedStep], env: list[str]) -> str:
    lines = [f'"""Recorded with the WorkPilot Browser Agent: {slug(name, " ")}."""']
    lines.append("")
    imports = (["import os"] if env else []) + (
        ["from urllib.parse import urlsplit"]
        if any(s.wait_request for s in steps)
        else []
    )
    if imports:
        lines += [*imports, ""]
    lines += ["from playwright.sync_api import Page, expect", "", ""]
    if env:
        lines.append("# Secrets are read from the environment: " + ", ".join(env) + ".")
    lines.append(f"def test_{slug(name, '_')}(page: Page) -> None:")
    lines += [f"    {line}" for s in steps for line in _pw_py_step(s)] or ["    pass"]
    return "\n".join(lines) + "\n"


# --- Cypress -----------------------------------------------------------------------


def _cy_scope(step: RecordedStep) -> str:
    """``cy``, then down the step's frames (same origin only) and shadow hosts."""
    scope = "cy"
    for frame in step.frames:
        get = "cy.get" if scope == "cy" else f"{scope}.find"
        scope = (
            f'{get}({literal(frame)}).its("0.contentDocument.body")'
            '.should("not.be.empty").then(cy.wrap)'
        )
    for host in step.shadow:
        get = "cy.get" if scope == "cy" else f"{scope}.find"
        scope = f"{get}({literal(host)}).shadow()"
    return scope


def _cy_query(scope: str, s: Selector) -> str | None:
    if s.nth is None:
        return _cy_first(scope, s)
    if s.strategy in ("role", "text"):
        return None  # cy.contains yields one element: no place to pick
    query = _cy_first(scope, s)
    return None if query is None else f"{query}.eq({s.nth})"


def _cy_first(scope: str, s: Selector) -> str | None:
    get = "cy.get" if scope == "cy" else f"{scope}.find"
    contains = f"{scope}.contains"
    if s.strategy == "testid":
        return f"{get}({literal(f'[data-testid="{css_string(s.value)}"]')})"
    if s.strategy == "role":
        css = _CYPRESS_ROLE_CSS.get(s.role)
        return f"{contains}({literal(css)}, {literal(s.value)})" if css else None
    if s.strategy == "placeholder":
        return f"{get}({literal(f'[placeholder="{css_string(s.value)}"]')})"
    if s.strategy == "text":
        return f"{contains}({literal(s.value)})"
    if s.strategy == "css":
        return f"{get}({literal(s.value)})"
    return None  # label: no query without Testing Library


def _cy_action(step: RecordedStep, query: str) -> str:
    if step.kind == "click":
        return f"{query}.click();"
    if step.kind == "fill":
        if step.secret_env:
            return (
                f"{query}.clear().type(Cypress.env({literal(step.secret_env)}), "
                "{ log: false });"
            )
        if not step.value:
            return f"{query}.clear();"
        return (
            f"{query}.clear().type({literal(step.value)}, "
            "{ parseSpecialCharSequences: false });"
        )
    if step.kind == "select":
        if step.secret_env:
            return f"{query}.select(Cypress.env({literal(step.secret_env)}));"
        return f"{query}.select({literal(step.value)});"
    if step.kind == "press":
        return f"{query}.type({literal(_CYPRESS_KEYS[step.key])});"
    return f'{query}.should("contain.text", {literal(step.text)});'


def _cy_step(step: RecordedStep) -> list[str] | None:
    if step.kind == "navigate":
        return [f"cy.visit({literal(step.url)});"]
    scope = _cy_scope(step)
    query = next(
        (q for q in (_cy_query(scope, s) for s in step.selectors) if q is not None),
        None,
    )
    if query is None:
        return None
    if step.wait_visible:
        query += '.should("be.visible")'
    lines: list[str] = []
    if step.wait_request:
        lines.append(
            f"cy.intercept({{ method: {literal(step.wait_request.method)}, "
            f"pathname: {literal(step.wait_request.path)} }}).as({literal(step.id)});"
        )
    lines.append(_cy_action(step, query))
    if step.wait_request:
        lines.append(f"cy.wait({literal('@' + step.id)});")
    if step.wait_hidden:
        lines.append(
            'cy.get("body").should((body) => expect(body.find('
            f'{literal(step.wait_hidden)}).filter(":visible")).to.have.length(0));'
        )
    if step.wait_url:
        lines.append(
            "cy.url().should((url) => expect(url.split(/[?#]/)[0]).to.equal("
            f"{literal(step.wait_url)}));"
        )
    return lines


def _cypress(name: str, steps: list[RecordedStep], env: list[str]) -> tuple[str, int]:
    lines: list[str] = []
    if env:
        lines += [
            "// Secrets are read with Cypress.env (CYPRESS_<NAME> in the environment): "
            + ", ".join(env)
            + ".",
            "",
        ]
    lines += [
        f"describe({literal(name)}, () => {{",
        f"\tit({literal('replays the recorded steps')}, () => {{",
    ]
    skipped = 0
    for step in steps:
        code = _cy_step(step)
        if code is None:
            skipped += 1
            lines.append("\t\t// step skipped: no selector Cypress can express")
        else:
            lines += [f"\t\t{line}" for line in code]
    lines += ["\t});", "});"]
    return "\n".join(lines) + "\n", skipped


Generator = Callable[[str, list[RecordedStep], list[str]], tuple[str, int]]

_GENERATORS: dict[str, Generator] = {
    "playwright-ts": lambda n, s, e: (_playwright_ts(n, s, e), 0),
    "playwright-python": lambda n, s, e: (_playwright_python(n, s, e), 0),
    "cypress": _cypress,
    "selenium-python": selenium_python,
    "selenium-java": selenium_java,
    "webdriverio": webdriverio,
}


def export_recording(
    recording: Recording, fmt: str, name: object = None, root: Path | None = None
) -> GeneratedTest:
    """``recording`` as a test file in ``fmt`` (one of :data:`FORMATS`)."""
    if fmt not in FORMATS:
        raise ValueError(f"Unknown test format: {fmt}")
    title = clean_name(name)
    steps = [s for s in recording.steps if s.kind == "navigate" or s.selectors]
    env = sorted({s.secret_env for s in steps if ENV_NAME.match(s.secret_env)})
    code, skipped = _GENERATORS[fmt](title, steps, env)
    return GeneratedTest(
        format=fmt,
        code=code,
        path=file_path(fmt, title, root),
        env_vars=env,
        skipped=skipped,
    )

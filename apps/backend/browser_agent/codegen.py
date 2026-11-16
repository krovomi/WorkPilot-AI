"""
A recording written out as a test: Playwright (TypeScript, Python) or Cypress.

Deterministic, no model. Every piece of page content (URL, label, text, typed
value) enters the code only as a string literal made by :func:`literal`, the
JSON form of the string with every non-ASCII character escaped: a valid
double-quoted literal in JavaScript, TypeScript and Python, so a quote, a
backslash, a line break, ``${…}`` or ``{enter}`` in a page stays text and never
becomes code, interpolation or a key sequence (Cypress ``type`` is told not to
parse ``{…}``). Page text never goes into a comment.

A secret field reads its value from an environment variable whose name the
recorder built from ``[A-Z0-9_]`` only (``recording.ENV_NAME``); the generated
file names the variables it needs at its top.

Each framework takes the first selector of a step it can express: Cypress has
no role or label query without an extra library, so it falls through to the
placeholder, the text or the CSS. A step none of its selectors fit is written
as a ``// step skipped`` comment, never guessed.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path

from .recording import ENV_NAME, RecordedStep, Recording, Selector

FORMATS = ("playwright-ts", "playwright-python", "cypress")
DEFAULT_NAME = "recorded flow"
MAX_NAME = 80

#: Where each framework's tests usually live, the first that exists wins.
TEST_DIRS: dict[str, tuple[str, ...]] = {
    "playwright-ts": ("e2e", "tests/e2e", "tests"),
    "playwright-python": ("tests/e2e", "tests", "e2e"),
    "cypress": ("cypress/e2e", "cypress/integration", "cypress"),
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


def literal(text: str) -> str:
    """``text`` as a safe double-quoted string literal (JS, TS and Python)."""
    return json.dumps(text, ensure_ascii=True)


def _slug(name: str, sep: str) -> str:
    words = re.findall(r"[a-z0-9]+", name.lower())
    return sep.join(words)[:60].strip(sep) or sep.join(["recorded", "flow"])


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
    if fmt == "playwright-python":
        return f"{folder}/test_{_slug(name, '_')}.py"
    if fmt == "cypress":
        return f"{folder}/{_slug(name, '-')}.cy.js"
    return f"{folder}/{_slug(name, '-')}.spec.ts"


# --- Playwright, TypeScript ----------------------------------------------------


def _pw_ts_locator(s: Selector) -> str:
    if s.strategy == "testid":
        return f"page.getByTestId({literal(s.value)})"
    if s.strategy == "role":
        return (
            f"page.getByRole({literal(s.role)}, "
            f"{{ name: {literal(s.value)}, exact: true }})"
        )
    if s.strategy == "label":
        return f"page.getByLabel({literal(s.value)}, {{ exact: true }})"
    if s.strategy == "placeholder":
        return f"page.getByPlaceholder({literal(s.value)}, {{ exact: true }})"
    if s.strategy == "text":
        return f"page.getByText({literal(s.value)}, {{ exact: true }})"
    return f"page.locator({literal(s.value)})"


def _pw_ts_step(step: RecordedStep) -> str:
    if step.kind == "navigate":
        return f"await page.goto({literal(step.url)});"
    loc = _pw_ts_locator(step.selectors[0])
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
    lines += [f"\t{_pw_ts_step(s)}" for s in steps]
    lines.append("});")
    return "\n".join(lines) + "\n"


# --- Playwright, Python ----------------------------------------------------------


def _pw_py_locator(s: Selector) -> str:
    if s.strategy == "testid":
        return f"page.get_by_test_id({literal(s.value)})"
    if s.strategy == "role":
        return (
            f"page.get_by_role({literal(s.role)}, name={literal(s.value)}, exact=True)"
        )
    if s.strategy == "label":
        return f"page.get_by_label({literal(s.value)}, exact=True)"
    if s.strategy == "placeholder":
        return f"page.get_by_placeholder({literal(s.value)}, exact=True)"
    if s.strategy == "text":
        return f"page.get_by_text({literal(s.value)}, exact=True)"
    return f"page.locator({literal(s.value)})"


def _pw_py_step(step: RecordedStep) -> str:
    if step.kind == "navigate":
        return f"page.goto({literal(step.url)})"
    loc = _pw_py_locator(step.selectors[0])
    if step.kind == "click":
        return f"{loc}.click()"
    if step.kind in ("fill", "select"):
        method = "fill" if step.kind == "fill" else "select_option"
        value = (
            f"os.environ[{literal(step.secret_env)}]"
            if step.secret_env
            else literal(step.value)
        )
        return f"{loc}.{method}({value})"
    if step.kind == "press":
        return f"{loc}.press({literal(step.key)})"
    return f"expect({loc}).to_contain_text({literal(step.text)})"


def _playwright_python(name: str, steps: list[RecordedStep], env: list[str]) -> str:
    lines = [f'"""Recorded with the WorkPilot Browser Agent: {_slug(name, " ")}."""']
    lines.append("")
    if env:
        lines += ["import os", ""]
    lines += ["from playwright.sync_api import Page, expect", "", ""]
    if env:
        lines.append("# Secrets are read from the environment: " + ", ".join(env) + ".")
    lines.append(f"def test_{_slug(name, '_')}(page: Page) -> None:")
    lines += [f"    {_pw_py_step(s)}" for s in steps] or ["    pass"]
    return "\n".join(lines) + "\n"


# --- Cypress -----------------------------------------------------------------------


def _css_string(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def _cy_query(s: Selector) -> str | None:
    if s.strategy == "testid":
        return f"cy.get({literal(f'[data-testid="{_css_string(s.value)}"]')})"
    if s.strategy == "role":
        css = _CYPRESS_ROLE_CSS.get(s.role)
        return f"cy.contains({literal(css)}, {literal(s.value)})" if css else None
    if s.strategy == "placeholder":
        return f"cy.get({literal(f'[placeholder="{_css_string(s.value)}"]')})"
    if s.strategy == "text":
        return f"cy.contains({literal(s.value)})"
    if s.strategy == "css":
        return f"cy.get({literal(s.value)})"
    return None  # label: no query without Testing Library


def _cy_step(step: RecordedStep) -> str | None:
    if step.kind == "navigate":
        return f"cy.visit({literal(step.url)});"
    query = next(
        (q for q in (_cy_query(s) for s in step.selectors) if q is not None), None
    )
    if query is None:
        return None
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
            lines.append(f"\t\t{code}")
    lines += ["\t});", "});"]
    return "\n".join(lines) + "\n", skipped


def export_recording(
    recording: Recording, fmt: str, name: object = None, root: Path | None = None
) -> GeneratedTest:
    """``recording`` as a test file in ``fmt`` (one of :data:`FORMATS`)."""
    if fmt not in FORMATS:
        raise ValueError(f"Unknown test format: {fmt}")
    title = clean_name(name)
    steps = [s for s in recording.steps if s.kind == "navigate" or s.selectors]
    env = sorted({s.secret_env for s in steps if ENV_NAME.match(s.secret_env)})
    skipped = 0
    if fmt == "playwright-ts":
        code = _playwright_ts(title, steps, env)
    elif fmt == "playwright-python":
        code = _playwright_python(title, steps, env)
    else:
        code, skipped = _cypress(title, steps, env)
    return GeneratedTest(
        format=fmt,
        code=code,
        path=file_path(fmt, title, root),
        env_vars=env,
        skipped=skipped,
    )

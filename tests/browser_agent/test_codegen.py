"""A recording written out as Playwright (TS, Python) and Cypress tests.

Page text is external content: whatever it holds, it comes out of the
generator as a string literal and nothing else.
"""

from __future__ import annotations

import ast
import json
import re
from pathlib import Path

import pytest
from browser_agent.codegen import (
    FORMATS,
    clean_name,
    export_recording,
    file_path,
    literal,
)
from browser_agent.recording import RecordedStep, Recording, Selector

HOSTILE = (
    'x"); require("child_process").exec("rm -rf /"); ("${process.env.HOME}`\n{enter}'
)
ROLE = Selector("role", "Sign in", "button")
LABEL = Selector("label", "Email")
CSS = Selector("css", "#email")


def _recording() -> Recording:
    return Recording(
        steps=[
            RecordedStep("s1", "navigate", url="http://localhost:3000/login"),
            RecordedStep("s2", "fill", [LABEL, CSS], value="ada@x.io"),
            RecordedStep(
                "s3", "fill", [Selector("label", "Password")], secret_env="E2E_PASSWORD"
            ),
            RecordedStep("s4", "select", [Selector("testid", "lang")], value="fr"),
            RecordedStep("s5", "click", [ROLE]),
            RecordedStep(
                "s6", "press", [Selector("placeholder", "Search")], key="Enter"
            ),
            RecordedStep(
                "s7", "assert_text", [Selector("text", "Welcome")], text="Welcome"
            ),
        ]
    )


def test_playwright_typescript() -> None:
    test = export_recording(_recording(), "playwright-ts", "Log in")
    assert test.path == "e2e/log-in.spec.ts" and test.env_vars == ["E2E_PASSWORD"]
    assert test.code.splitlines() == [
        'import { expect, test } from "@playwright/test";',
        "",
        "// Secrets are read from the environment: E2E_PASSWORD.",
        "function secret(name: string): string {",
        "\tconst value = process.env[name];",
        '\tif (!value) throw new Error("Set " + name + " to run this test");',
        "\treturn value;",
        "}",
        "",
        'test("Log in", async ({ page }) => {',
        '\tawait page.goto("http://localhost:3000/login");',
        '\tawait page.getByLabel("Email", { exact: true }).fill("ada@x.io");',
        '\tawait page.getByLabel("Password", { exact: true }).fill(secret("E2E_PASSWORD"));',
        '\tawait page.getByTestId("lang").selectOption("fr");',
        '\tawait page.getByRole("button", { name: "Sign in", exact: true }).click();',
        '\tawait page.getByPlaceholder("Search", { exact: true }).press("Enter");',
        '\tawait expect(page.getByText("Welcome", { exact: true })).toContainText("Welcome");',
        "});",
    ]


def test_playwright_python_is_valid_python() -> None:
    test = export_recording(_recording(), "playwright-python", "Log in")
    assert test.path == "tests/e2e/test_log_in.py"
    ast.parse(test.code)
    lines = test.code.splitlines()
    assert "import os" in lines
    assert "# Secrets are read from the environment: E2E_PASSWORD." in lines
    assert lines[lines.index("def test_log_in(page: Page) -> None:") + 1 :] == [
        '    page.goto("http://localhost:3000/login")',
        '    page.get_by_label("Email", exact=True).fill("ada@x.io")',
        '    page.get_by_label("Password", exact=True).fill(os.environ["E2E_PASSWORD"])',
        '    page.get_by_test_id("lang").select_option("fr")',
        '    page.get_by_role("button", name="Sign in", exact=True).click()',
        '    page.get_by_placeholder("Search", exact=True).press("Enter")',
        '    expect(page.get_by_text("Welcome", exact=True)).to_contain_text("Welcome")',
    ]


def test_cypress_falls_through_to_a_selector_it_can_express() -> None:
    test = export_recording(_recording(), "cypress", "Log in")
    assert test.path == "cypress/e2e/log-in.cy.js" and test.skipped == 1
    assert test.code.splitlines() == [
        "// Secrets are read with Cypress.env (CYPRESS_<NAME> in the environment): E2E_PASSWORD.",
        "",
        'describe("Log in", () => {',
        '\tit("replays the recorded steps", () => {',
        '\t\tcy.visit("http://localhost:3000/login");',
        '\t\tcy.get("#email").clear().type("ada@x.io", { parseSpecialCharSequences: false });',
        "\t\t// step skipped: no selector Cypress can express",
        '\t\tcy.get("[data-testid=\\"lang\\"]").select("fr");',
        '\t\tcy.contains("button, [role=\\"button\\"], input[type=\\"submit\\"], input[type=\\"button\\"]", "Sign in").click();',
        '\t\tcy.get("[placeholder=\\"Search\\"]").type("{enter}");',
        '\t\tcy.contains("Welcome").should("contain.text", "Welcome");',
        "\t});",
        "});",
    ]


def test_cypress_secrets_empty_values_and_unknown_roles() -> None:
    field = Selector("css", "#pw")
    recording = Recording(
        steps=[
            RecordedStep("s1", "fill", [field], secret_env="E2E_PW"),
            RecordedStep("s2", "fill", [field]),
            RecordedStep("s3", "select", [field], secret_env="E2E_PLAN"),
            RecordedStep("s4", "click", [Selector("role", "Dark", "switch")]),
            RecordedStep("s5", "press", [field], key="Escape"),
        ]
    )
    lines = export_recording(recording, "cypress").code.splitlines()
    assert (
        '\t\tcy.get("#pw").clear().type(Cypress.env("E2E_PW"), { log: false });'
        in lines
    )
    assert '\t\tcy.get("#pw").clear();' in lines
    assert '\t\tcy.get("#pw").select(Cypress.env("E2E_PLAN"));' in lines
    assert "\t\t// step skipped: no selector Cypress can express" in lines
    assert '\t\tcy.get("#pw").type("{esc}");' in lines


@pytest.mark.parametrize("fmt", FORMATS)
def test_hostile_page_text_stays_a_string_literal(fmt: str) -> None:
    recording = Recording(
        steps=[
            RecordedStep("s1", "navigate", url="http://localhost/?q=" + HOSTILE),
            RecordedStep("s2", "fill", [Selector("label", HOSTILE)], value=HOSTILE),
            RecordedStep("s3", "assert_text", [Selector("css", HOSTILE)], text=HOSTILE),
        ]
    )
    code = export_recording(recording, fmt, HOSTILE).code
    encoded = literal(HOSTILE)
    assert json.loads(encoded) == HOSTILE and "\n" not in encoded
    # Outside its double-quoted literals, the code holds none of the payload.
    outside = re.sub(r'"(?:[^"\\\n]|\\.)*"', "", code)
    for piece in ("require(", "${", "`", "rm -rf", "{enter}"):
        assert piece not in outside, (fmt, piece)
    if fmt == "playwright-python":
        tree = ast.parse(code)
        constants = {n.value for n in ast.walk(tree) if isinstance(n, ast.Constant)}
        assert HOSTILE in constants


def test_names_paths_and_unknown_formats(tmp_path: Path) -> None:
    assert clean_name(None) == "recorded flow"
    assert clean_name("  a\n\x00b  ") == "a b"
    assert clean_name("   ") == "recorded flow"
    assert len(clean_name("n" * 300)) == 80
    assert file_path("cypress", "é!") == "cypress/e2e/recorded-flow.cy.js"
    (tmp_path / "tests").mkdir()
    assert file_path("playwright-ts", "Go", tmp_path) == "tests/go.spec.ts"
    with pytest.raises(ValueError, match="Unknown test format"):
        export_recording(_recording(), "selenium")


def test_steps_without_selectors_and_empty_tests() -> None:
    lost = Recording(steps=[RecordedStep("s1", "click")])
    test = export_recording(lost, "playwright-python")
    assert test.code.splitlines()[-1] == "    pass" and test.env_vars == []
    assert "import os" not in test.code
    ts = export_recording(lost, "playwright-ts").code
    assert "secret(" not in ts and ts.endswith("});\n")
    assert export_recording(lost, "cypress").to_dict()["skipped"] == 0

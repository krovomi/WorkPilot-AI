"""Hovers, scrolls, drags, multiple lists, dialogs, places and frames inside
shadow roots, written by every framework; and the four new WebDriver languages.
"""

from __future__ import annotations

import ast
import json
import re

import pytest
from browser_agent.codegen import FORMATS, export_recording, file_path
from browser_agent.codegen_text import cs_literal, ruby_literal
from browser_agent.codegen_webdriver import placed_locator, typed, webdriver_locator
from browser_agent.recording import Recording, Selector

from tests.browser_agent.literal_decoders import cs_decode, ruby_decode

HOSTILE = 'x"); `${a}` #{b} #@c \\ \n é😀 {enter}'
CSS = [{"strategy": "css", "value": "#x"}]


def _rich() -> Recording:
    return Recording.from_dict(
        {
            "steps": [
                {"id": "s1", "kind": "navigate", "url": "http://localhost:3000/"},
                {
                    "id": "s2",
                    "kind": "hover",
                    "selectors": [{"strategy": "css", "value": "#menu"}],
                },
                {
                    "id": "s3",
                    "kind": "scroll",
                    "selectors": [],
                    "scrollX": 0,
                    "scrollY": 1200,
                    "waitRequest": {"method": "GET", "path": "/api/more"},
                },
                {
                    "id": "s4",
                    "kind": "scroll",
                    "selectors": [{"strategy": "css", "value": "#list"}],
                    "scrollX": 3,
                    "scrollY": 300,
                },
                {
                    "id": "s5",
                    "kind": "drag",
                    "selectors": [{"strategy": "testid", "value": "card"}],
                    "drop": [{"strategy": "css", "value": "#done"}],
                    "dragMode": "html5",
                },
                {
                    "id": "s6",
                    "kind": "drag",
                    "selectors": [{"strategy": "css", "value": "#a"}],
                    "drop": [{"strategy": "placeholder", "value": "Drop", "nth": 2}],
                    "dragMode": "pointer",
                },
                {
                    "id": "s7",
                    "kind": "select",
                    "selectors": [{"strategy": "css", "value": "#tags"}],
                    "value": "a",
                    "values": ["a", HOSTILE],
                },
                {
                    "id": "s8",
                    "kind": "click",
                    "selectors": [{"strategy": "css", "value": "#del"}],
                    "dialog": {"type": "confirm", "accept": True},
                },
                {
                    "id": "s9",
                    "kind": "click",
                    "selectors": [{"strategy": "css", "value": "#ren"}],
                    "dialog": {"type": "prompt", "accept": True, "text": HOSTILE},
                    "waitRequest": {"method": "POST", "path": "/api/r"},
                },
                {
                    "id": "s10",
                    "kind": "click",
                    "selectors": [{"strategy": "css", "value": "#no"}],
                    "dialog": {"type": "prompt", "accept": False},
                },
                {
                    "id": "s11",
                    "kind": "fill",
                    "selectors": [{"strategy": "css", "value": "input"}],
                    "value": HOSTILE,
                    "frames": ["#pay", "#inner"],
                    "frameShadow": [["x-shell"], []],
                },
                {
                    "id": "s12",
                    "kind": "assert_text",
                    "selectors": [{"strategy": "text", "value": "Saved", "nth": 3}],
                    "text": "Saved",
                },
                {
                    "id": "s13",
                    "kind": "fill",
                    "selectors": [{"strategy": "css", "value": "#pw"}],
                    "secretEnv": "E2E_PW",
                },
                {
                    "id": "s14",
                    "kind": "click",
                    "selectors": [{"strategy": "css", "value": "#ok"}],
                    "dialog": {"type": "alert", "accept": True},
                    "waitHidden": ".spinner",
                    "waitUrl": "http://localhost:3000/home",
                },
            ]
        }
    )


def _body(code: str) -> str:
    return code


def test_playwright_typescript() -> None:
    code = export_recording(_rich(), "playwright-ts", "Rich").code
    for line in (
        'await page.locator("#menu").hover();',
        "await page.evaluate(([x, y]) => window.scrollTo(x, y), [0, 1200]);",
        'await page.locator("#list").evaluate((el, [x, y]) => el.scrollTo(x, y), [3, 300]);',
        'await page.getByTestId("card").dragTo(page.locator("#done"));',
        'await page.locator("#a").dragTo(page.getByPlaceholder("Drop", { exact: true }).nth(2));',
        'page.once("dialog", (dialog) => dialog.accept());',
        f'page.once("dialog", (dialog) => dialog.accept({json.dumps(HOSTILE, ensure_ascii=True)}));',
        'page.once("dialog", (dialog) => dialog.dismiss());',
        'await page.locator("x-shell").frameLocator("#pay").frameLocator("#inner")'
        '.locator("input").fill(',
    ):
        assert line in code, line
    # The handler is set before the action that opens the dialog.
    assert code.index("dialog.dismiss()") < code.index('locator("#no").click()')


def test_playwright_python() -> None:
    code = export_recording(_rich(), "playwright-python", "Rich").code
    ast.parse(code)
    for line in (
        'page.locator("#menu").hover()',
        'page.evaluate("([x, y]) => window.scrollTo(x, y)", [0, 1200])',
        'page.locator("#list").evaluate("(el, [x, y]) => el.scrollTo(x, y)", [3, 300])',
        'page.get_by_test_id("card").drag_to(page.locator("#done"))',
        'page.once("dialog", lambda dialog: dialog.accept())',
        'page.once("dialog", lambda dialog: dialog.dismiss())',
        'page.locator("x-shell").frame_locator("#pay").frame_locator("#inner")',
    ):
        assert line in code, line


def test_cypress() -> None:
    test = export_recording(_rich(), "cypress", "Rich")
    code = test.code
    for line in (
        'cy.get("#menu").trigger("mouseover");',
        "cy.scrollTo(0, 1200);",
        'cy.get("#list").scrollTo(3, 300);',
        "{ const dataTransfer = new DataTransfer(); "
        'cy.get("[data-testid=\\"card\\"]").trigger("dragstart", { dataTransfer });',
        'cy.get("#a").trigger("pointerdown", { button: 0 })',
        'cy.get("[placeholder=\\"Drop\\"]").eq(2).trigger("pointermove")',
        'cy.once("window:confirm", () => true);',
        'cy.window().then((win) => cy.stub(win, "prompt").returns(null));',
        'cy.get("x-shell").shadow().find("#pay").its("0.contentDocument.body")',
    ):
        assert line in code, line
    # The text with a place has no Cypress query; an alert needs no handler.
    assert test.skipped == 1 and "window:alert" not in code


def test_cypress_skips_a_drag_whose_drop_it_cannot_name() -> None:
    recording = Recording.from_dict(
        {
            "steps": [
                {
                    "id": "s1",
                    "kind": "drag",
                    "selectors": CSS,
                    "drop": [{"strategy": "role", "role": "switch", "value": "Bin"}],
                    "dragMode": "pointer",
                }
            ]
        }
    )
    assert export_recording(recording, "cypress").skipped == 1
    assert export_recording(recording, "selenium-python").skipped == 1


def test_webdriver_keeps_a_place_only_where_it_finds_it_the_same_way() -> None:
    assert placed_locator(Selector("placeholder", "Q", nth=1)) == (
        "css",
        '[placeholder="Q"]',
        1,
    )
    text = placed_locator(Selector("text", "Go", nth=0))
    assert text is not None and text[0] == "xpath" and text[2] == 0
    assert placed_locator(Selector("role", "Go", "button", nth=1)) is None
    assert placed_locator(Selector("label", "Email", nth=1)) is None
    assert webdriver_locator(Selector("placeholder", "Q", nth=1)) is None
    assert typed("a<<: string>>b", ts=True) == "a: stringb"
    assert typed("a<<: string>>b", ts=False) == "ab"


def test_selenium_python() -> None:
    code = export_recording(_rich(), "selenium-python", "Rich").code
    ast.parse(code)
    for line in (
        'ActionChains(driver).move_to_element(locate(driver, By.CSS_SELECTOR, "#menu")).perform()',
        "scroll_window(driver, 0, 1200)",
        'driver.execute_script(SCROLL_ELEMENT, locate(driver, By.CSS_SELECTOR, "#list"), 3, 300)',
        "driver.execute_script(DRAG_HTML5, ",
        "ActionChains(driver).drag_and_drop(",
        'locate(driver, By.CSS_SELECTOR, "[placeholder=\\"Drop\\"]", nth=2)',
        "answer_dialog(driver, True)",
        "answer_dialog(driver, False)",
        'frames=[["x-shell", "#pay"], ["#inner"]]',
        "nth=3",
        "def answer_dialog(driver, accept, text=None):",
        "def scroll_window(driver, x, y):",
        "from selenium.webdriver.common.action_chains import ActionChains",
    ):
        assert line in code, line
    constants = {
        n.value for n in ast.walk(ast.parse(code)) if isinstance(n, ast.Constant)
    }
    assert HOSTILE in constants


def test_selenium_java() -> None:
    code = export_recording(_rich(), "selenium-java", "Rich").code
    for line in (
        'new Actions(driver).moveToElement(locate(By.cssSelector("#menu"))).perform();',
        "scrollWindow(0, 1200);",
        'script(SCROLL_ELEMENT, locate(By.cssSelector("#list")), 3, 300);',
        "script(DRAG_HTML5, ",
        'new String[][] {{"x-shell", "#pay"}, {"#inner"}}',
        "answerDialog(true, null);",
        "answerDialog(false, null);",
        "import org.openqa.selenium.Alert;",
        "import org.openqa.selenium.interactions.Actions;",
        "private Object script(String code, Object... args) {",
    ):
        assert line in code, line


def test_webdriverio_javascript_and_typescript() -> None:
    js = export_recording(_rich(), "webdriverio", "Rich")
    ts = export_recording(_rich(), "webdriverio-ts", "Rich")
    assert ts.path == "test/specs/rich.e2e.ts" and js.path == "test/specs/rich.e2e.js"
    for line in (
        'await (await locate("#menu")).moveTo();',
        "await scrollWindow(0, 1200);",
        'await (await locate("#a")).dragAndDrop((await locate("[placeholder=\\"Drop\\"]", { nth: 2 })));',
        "await answerDialog(true);",
        'frames: [["x-shell", "#pay"], ["#inner"]]',
    ):
        assert line in js.code and line in ts.code, line
    assert "<<" not in js.code and "<<" not in ts.code
    assert "async function locate(\n\tselector: string," in ts.code
    assert "selector:" not in js.code and "type Frame" not in js.code


def test_selenium_csharp() -> None:
    test = export_recording(_rich(), "selenium-csharp", "Rich")
    assert test.path == "tests/E2E/RichTests.cs"
    code = test.code
    for line in (
        "namespace E2E",
        "\tpublic class RichTests",
        'driver.Navigate().GoToUrl("http://localhost:3000/");',
        'new Actions(driver).MoveToElement(Locate(By.CssSelector("#menu"))).Perform();',
        "ScrollWindow(0, 1200);",
        "Script(DragHtml5, ",
        'Locate(By.CssSelector("input"), frames: new[] {new string[] {"x-shell", "#pay"}, '
        'new string[] {"#inner"}})',
        "nth: 3",
        "AnswerDialog(true, null);",
        'Fill(Locate(By.CssSelector("#pw")), Secret(TestData["pw_env"]));',
        "var element = Locate(",
        "using OpenQA.Selenium.Interactions;",
    ):
        assert line in code, line
    literals = re.findall(r'"(?:[^"\\\n]|\\.)*"', code)
    assert HOSTILE in {cs_decode(lit) for lit in literals}


def test_selenium_ruby() -> None:
    test = export_recording(_rich(), "selenium-ruby", "Rich")
    assert test.path == "spec/e2e/rich_spec.rb"
    code = test.code
    for line in (
        "# frozen_string_literal: true",
        'RSpec.describe "Rich" do',
        '@driver.action.move_to(locate(:css, "#menu")).perform',
        "scroll_window(0, 1200)",
        '@driver.action.drag_and_drop(locate(:css, "#a"), locate(:css, "[placeholder=\\"Drop\\"]", nth: 2)).perform',
        'frames: [["x-shell", "#pay"], ["#inner"]]',
        "answer_dialog(true)",
        'fill(locate(:css, "#pw"), ENV.fetch(test_data.fetch("pw_env")))',
        "DRAG_HTML5 = ",
        "def answer_dialog(accept, text = nil)",
    ):
        assert line in code, line
    literals = re.findall(r'"(?:[^"\\\n]|\\.)*"', code)
    assert HOSTILE in {ruby_decode(lit) for lit in literals}


def test_selenium_javascript() -> None:
    test = export_recording(_rich(), "selenium-js", "Rich")
    assert test.path == "test/e2e/rich.e2e.cjs"
    code = test.code
    for line in (
        'const { Browser, Builder, By, Key, until } = require("selenium-webdriver");',
        'await driver.actions().move({ origin: (await locate(By.css("#menu"))) }).perform();',
        "await scrollWindow(0, 1200);",
        "await driver.executeScript(DRAG_HTML5, ",
        "await driver.actions().dragAndDrop(",
        'frames: [["x-shell", "#pay"], ["#inner"]]',
        "await answerDialog(true);",
        'await fill((await locate(By.css("#pw"))), secret(TEST_DATA["pw_env"]));',
    ):
        assert line in code, line
    literals = re.findall(r'"(?:[^"\\\n]|\\.)*"', code)
    assert HOSTILE in {json.loads(lit) for lit in literals}


def test_plain_steps_need_no_extra_helper() -> None:
    plain = Recording.from_dict(
        {"steps": [{"id": "s1", "kind": "click", "selectors": CSS}]}
    )
    for fmt in FORMATS:
        code = export_recording(plain, fmt).code
        for helper in ("DRAG_HTML5", "SELECT_VALUES", "answerDialog", "answer_dialog"):
            assert helper not in code, (fmt, helper)
    assert "until" not in export_recording(plain, "selenium-js").code.splitlines()[0]
    assert "Interactions" not in export_recording(plain, "selenium-csharp").code


def test_the_new_languages_go_down_frames_and_shadow_roots() -> None:
    placed = Recording.from_dict(
        {
            "steps": [
                {
                    "id": "s1",
                    "kind": "click",
                    "selectors": CSS,
                    "frames": ["#pay"],
                    "shadow": ["x-card"],
                    "waitVisible": True,
                }
            ]
        }
    )
    expected = {
        "selenium-csharp": (
            'frames: new[] {new string[] {"#pay"}}',
            'hosts: new string[] {"x-card"}',
            "visible: true",
        ),
        "selenium-ruby": ('frames: ["#pay"]', 'hosts: ["x-card"]', "visible: true"),
        "selenium-js": ('frames: [["#pay"]]', 'hosts: ["x-card"]', "visible: true"),
    }
    for fmt, parts in expected.items():
        code = export_recording(placed, fmt).code
        for part in parts:
            assert part in code, (fmt, part)


def test_the_new_languages_pick_an_option_and_press_a_key() -> None:
    steps = Recording.from_dict(
        {
            "steps": [
                {"id": "s1", "kind": "select", "selectors": CSS, "value": "fr"},
                {"id": "s2", "kind": "press", "selectors": CSS, "key": "Enter"},
                {"id": "s3", "kind": "press", "selectors": CSS, "key": "Escape"},
            ]
        }
    )
    expected = {
        "selenium-csharp": (
            'new SelectElement(Locate(By.CssSelector("#x"))).SelectByValue("fr");',
            "SendKeys(Keys.Enter);",
            "SendKeys(Keys.Escape);",
        ),
        "selenium-ruby": (
            'Select.new(locate(:css, "#x")).select_by(:value, "fr")',
            "send_keys(:enter)",
            "send_keys(:escape)",
        ),
        "selenium-js": (
            "await new Select(",
            "sendKeys(Key.ENTER);",
            "sendKeys(Key.ESCAPE);",
        ),
    }
    for fmt, parts in expected.items():
        code = export_recording(steps, fmt).code
        for part in parts:
            assert part in code, (fmt, part)


def test_new_formats_find_the_project_test_folder(tmp_path) -> None:
    (tmp_path / "spec" / "features").mkdir(parents=True)
    assert (
        file_path("selenium-ruby", "Log in", tmp_path) == "spec/features/log_in_spec.rb"
    )
    assert file_path("selenium-csharp", "Log in") == "tests/E2E/LogInTests.cs"
    assert file_path("selenium-js", "Log in") == "test/e2e/log-in.e2e.cjs"


@pytest.mark.parametrize(
    "text", ["", "plain", HOSTILE, "\0\x07\b\f\t\r", "\U0001f600 "]
)
def test_csharp_and_ruby_literals_read_back_exactly(text: str) -> None:
    assert cs_decode(cs_literal(text)) == text
    assert ruby_decode(ruby_literal(text)) == text
    assert "#{" not in ruby_literal(text).replace("\\#", "")

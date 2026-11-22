"""A recording written out as Selenium (Python, Java) and WebdriverIO tests.

The same steps as the Playwright and Cypress exports, the same model: each
selector becomes CSS or XPath, the frames and shadow hosts are gone down,
the observed transitions are waited for, and page text is only ever a
literal of the target language.
"""

from __future__ import annotations

import ast
import json
import re

import pytest
from browser_agent.codegen import export_recording
from browser_agent.codegen_webdriver import webdriver_locator
from browser_agent.recording import RecordedStep, Recording, RequestWait, Selector

from tests.browser_agent.literal_decoders import java_decode

HOSTILE = 'x"); System.exit(1); ("${process.env.HOME}`\\\n{enter}\'"'
ROLE = Selector("role", "Sign in", "button")


def _recording() -> Recording:
    return Recording(
        steps=[
            RecordedStep("s1", "navigate", url="http://localhost:3000/login"),
            RecordedStep("s2", "fill", [Selector("css", "#email")], value="ada@x.io"),
            RecordedStep("s3", "fill", [Selector("css", "#pw")], secret_env="E2E_PW"),
            RecordedStep(
                "s4", "select", [Selector("testid", "lang")], value="fr", frames=["#f"]
            ),
            RecordedStep(
                "s5",
                "click",
                [ROLE],
                wait_request=RequestWait("POST", "/api/login"),
                wait_url="http://localhost:3000/home",
            ),
            RecordedStep(
                "s6",
                "press",
                [Selector("placeholder", "Search")],
                key="Enter",
                shadow=["x-search"],
                wait_visible=True,
            ),
            RecordedStep("s7", "press", [Selector("css", "#q")], key="Escape"),
            RecordedStep(
                "s8", "assert_text", [Selector("text", "Welcome")], text="Welcome"
            ),
            # Inside a shadow root only CSS is found: the label falls through.
            RecordedStep(
                "s9",
                "click",
                [Selector("label", "Email"), Selector("css", "input")],
                shadow=["x-a", "x-b"],
            ),
            RecordedStep("s10", "click", [Selector("role", "Dark", "switch")]),
        ]
    )


ROLE_XPATH = (
    '//*[(self::button or self::summary or @role="button" or '
    'self::input[@type="submit" or @type="button" or @type="reset"]) and '
    '(normalize-space(.)="Sign in" or @aria-label="Sign in" or @value="Sign in")]'
)


def test_selectors_become_css_or_xpath() -> None:
    assert webdriver_locator(Selector("testid", 'a"b')) == (
        "css",
        '[data-testid="a\\"b"]',
    )
    assert webdriver_locator(Selector("placeholder", "Q")) == (
        "css",
        '[placeholder="Q"]',
    )
    assert webdriver_locator(Selector("css", "#a")) == ("css", "#a")
    assert webdriver_locator(ROLE) == ("xpath", ROLE_XPATH)
    assert webdriver_locator(Selector("text", "Go")) == (
        "xpath",
        '//*[normalize-space(.)="Go"][not(.//*[normalize-space(.)="Go"])]',
    )
    label = webdriver_locator(Selector("label", "Email"))
    assert label is not None and label[0] == "xpath"
    assert label[1].startswith('//*[@id=//label[normalize-space(.)="Email"]/@for]')
    # A role named by something else than its text, or any non-CSS in a shadow root.
    assert webdriver_locator(Selector("role", "Dark", "switch")) is None
    assert webdriver_locator(ROLE, in_shadow=True) is None
    assert webdriver_locator(Selector("css", "#a"), in_shadow=True) == ("css", "#a")


def test_selenium_python() -> None:
    test = export_recording(_recording(), "selenium-python", "Log in")
    assert test.path == "tests/e2e/test_log_in.py" and test.skipped == 1
    tree = ast.parse(test.code)
    assert "test_log_in" in {
        n.name for n in ast.walk(tree) if isinstance(n, ast.FunctionDef)
    }
    lines = test.code.splitlines()
    assert "import os" in lines
    assert "time.sleep" not in test.code and "implicitly_wait" not in test.code
    body = lines[lines.index("def test_log_in(driver) -> None:") + 1 :]
    assert body == [
        '    driver.get("http://localhost:3000/login")',
        '    fill(locate(driver, By.CSS_SELECTOR, "#email"), TEST_DATA["email"])',
        '    fill(locate(driver, By.CSS_SELECTOR, "#pw"), os.environ["E2E_PW"])',
        '    Select(locate(driver, By.CSS_SELECTOR, "[data-testid=\\"lang\\"]", '
        'frames=["#f"])).select_by_value("fr")',
        "    element = locate(driver, By.XPATH, " + json.dumps(ROLE_XPATH) + ")",
        "    seen = network_seen(driver)",
        "    element.click()",
        "    wait_for_network(driver, seen)",
        '    wait_for_page(driver, "http://localhost:3000/home")',
        '    locate(driver, By.CSS_SELECTOR, "[placeholder=\\"Search\\"]", '
        'hosts=["x-search"], visible=True).send_keys(Keys.ENTER)',
        '    locate(driver, By.CSS_SELECTOR, "#q").send_keys(Keys.ESCAPE)',
        '    expect_text(driver, locate(driver, By.XPATH, "//*[normalize-space(.)='
        '\\"Welcome\\"][not(.//*[normalize-space(.)=\\"Welcome\\"])]"), "Welcome")',
        '    locate(driver, By.CSS_SELECTOR, "input", hosts=["x-a", "x-b"]).click()',
        "    # step skipped: no selector Selenium can express",
    ]


def test_selenium_java() -> None:
    test = export_recording(_recording(), "selenium-java", "Log in")
    assert test.path == "src/test/java/e2e/LogInTest.java" and test.skipped == 1
    assert test.code.startswith("package e2e;\n") and "class LogInTest {" in test.code
    assert "Thread.sleep" not in test.code and "implicitlyWait" not in test.code
    assert "private static String secret(String name)" in test.code
    assert test.data_path is None and test.data_code is None
    assert '\t\tstatic final String EMAIL = "ada@x.io";' in test.code.splitlines()
    lines = test.code.splitlines()
    body = lines[lines.index("\tvoid replaysTheRecordedSteps() {") + 1 : -2]
    assert body == [
        '\t\tdriver.get("http://localhost:3000/login");',
        '\t\tfill(locate(By.cssSelector("#email")), TestData.EMAIL);',
        '\t\tfill(locate(By.cssSelector("#pw")), secret("E2E_PW"));',
        '\t\tnew Select(locate(By.cssSelector("[data-testid=\\"lang\\"]"), '
        'new String[] {"#f"}, new String[] {}, false)).selectByValue("fr");',
        "\t\t{",
        f"\t\t\tWebElement element = locate(By.xpath({json.dumps(ROLE_XPATH)}));",
        "\t\t\tlong seen = networkSeen();",
        "\t\t\telement.click();",
        "\t\t\twaitForNetwork(seen);",
        "\t\t}",
        '\t\twaitForPage("http://localhost:3000/home");',
        '\t\tlocate(By.cssSelector("[placeholder=\\"Search\\"]"), new String[] {}, '
        'new String[] {"x-search"}, true).sendKeys(Keys.ENTER);',
        '\t\tlocate(By.cssSelector("#q")).sendKeys(Keys.ESCAPE);',
        '\t\texpectText(locate(By.xpath("//*[normalize-space(.)=\\"Welcome\\"]'
        '[not(.//*[normalize-space(.)=\\"Welcome\\"])]")), "Welcome");',
        '\t\tlocate(By.cssSelector("input"), new String[] {}, '
        'new String[] {"x-a", "x-b"}, false).click();',
        "\t\t// step skipped: no selector Selenium can express",
    ]


def test_webdriverio() -> None:
    test = export_recording(_recording(), "webdriverio", "Log in")
    assert test.path == "test/specs/log-in.e2e.js" and test.skipped == 1
    assert test.code.startswith(
        'import { readFileSync } from "node:fs";\n'
        'import { $, $$, browser, expect } from "@wdio/globals";'
    )
    assert test.data_path == "test/specs/log-in.data.json"
    assert (
        '\treadFileSync(new URL("log-in.data.json", import.meta.url), "utf-8"),'
        in test.code.splitlines()
    )
    assert "browser.pause" not in test.code
    lines = test.code.splitlines()
    body = lines[
        lines.index('\tit("replays the recorded steps", async () => {') + 1 : -2
    ]
    assert body == [
        '\t\tawait browser.url("http://localhost:3000/login");',
        '\t\tawait (await locate("#email")).setValue(TEST_DATA["email"]);',
        '\t\tawait (await locate("#pw")).setValue(secret("E2E_PW"));',
        '\t\tawait (await locate("[data-testid=\\"lang\\"]", { frames: ["#f"] }))'
        '.selectByAttribute("value", "fr");',
        "\t\t{",
        f"\t\t\tconst element = await locate({json.dumps(ROLE_XPATH)});",
        "\t\t\tconst seen = await networkSeen();",
        "\t\t\tawait element.click();",
        "\t\t\tawait waitForNetwork(seen);",
        "\t\t}",
        '\t\tawait waitForPage("http://localhost:3000/home");',
        '\t\tawait (await locate("[placeholder=\\"Search\\"]", { hosts: ["x-search"], '
        'visible: true })).addValue("\\ue007");',
        '\t\tawait (await locate("#q")).addValue("\\ue00c");',
        '\t\tawait expect((await locate("//*[normalize-space(.)=\\"Welcome\\"]'
        '[not(.//*[normalize-space(.)=\\"Welcome\\"])]"))).toHaveText('
        'expect.stringContaining("Welcome"));',
        '\t\tawait (await locate("input", { hosts: ["x-a", "x-b"] })).click();',
        "\t\t// step skipped: no selector WebdriverIO can express",
    ]


def test_no_secret_no_helper_and_empty_tests() -> None:
    empty = Recording(steps=[RecordedStep("s1", "click")])
    py = export_recording(empty, "selenium-python").code
    assert py.splitlines()[-1] == "    pass" and "import os" not in py
    java = export_recording(empty, "selenium-java").code
    assert "secret(" not in java and "class RecordedFlowTest {" in java
    assert "secret(" not in export_recording(empty, "webdriverio").code


def _hostile() -> Recording:
    return Recording(
        steps=[
            RecordedStep("s1", "navigate", url="http://localhost/?q=" + HOSTILE),
            RecordedStep(
                "s2",
                "fill",
                [Selector("label", HOSTILE)],
                value=HOSTILE,
                frames=[HOSTILE],
                wait_url="http://localhost/" + HOSTILE,
            ),
            RecordedStep(
                "s3",
                "select",
                [Selector("css", HOSTILE)],
                value=HOSTILE,
                shadow=[HOSTILE],
                wait_request=RequestWait("POST", "/" + HOSTILE),
            ),
            RecordedStep(
                "s4", "assert_text", [Selector("text", HOSTILE)], text=HOSTILE
            ),
            RecordedStep("s5", "click", [Selector("role", HOSTILE, "link")]),
        ]
    )


_JS_STRING = re.compile(r'"(?:[^"\\\n]|\\.)*"')


def _outside(code: str) -> str:
    return _JS_STRING.sub("", code)


@pytest.mark.parametrize("fmt", ["selenium-python", "selenium-java", "webdriverio"])
def test_hostile_page_text_stays_a_string_literal(fmt: str) -> None:
    code = export_recording(_hostile(), fmt, HOSTILE).code
    for piece in ("System.exit", "${", "`", "{enter}"):
        assert piece not in _outside(code), (fmt, piece)
    literals = _JS_STRING.findall(code)
    if fmt == "selenium-python":
        constants = {
            n.value for n in ast.walk(ast.parse(code)) if isinstance(n, ast.Constant)
        }
        assert HOSTILE in constants and "/" + HOSTILE not in _outside(code)
    elif fmt == "selenium-java":
        assert HOSTILE in {java_decode(lit) for lit in literals}
    else:
        assert HOSTILE in {json.loads(lit) for lit in literals}

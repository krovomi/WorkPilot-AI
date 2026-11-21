"""
A recording as a WebDriver test: Selenium (Python with pytest, Java with
JUnit 5) and WebdriverIO (JavaScript, Mocha).

The three share one walk over the steps (:func:`_steps`) and differ only by
their :class:`_Dialect`: how a literal is written, how an element is found,
how an action, a binding and a wait are spelled. Page text enters through the
dialect's literal function only (``codegen_text``).

WebDriver finds an element by CSS or XPath. A selector of the recording
becomes one of those (:func:`webdriver_locator`): a test id or a placeholder
as a CSS attribute selector, a label, a text or a role named by its text as
an XPath, the XPath string built by ``xpath_string``. Inside a shadow root
WebDriver only finds by CSS, so those steps take their first CSS selector
(the recorder always gives one, its CSS path last).

Nothing pauses for a fixed time: each lookup waits until the element is there
(and shows, when it appeared after the previous action); a request the action
started is waited for by counting the page's ``fetch`` and XHR calls (a
script of this module, not of the page); the page an action led to, by its
URL without query or fragment.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from .codegen_text import (
    css_string,
    java_literal,
    literal,
    pascal,
    py_literal,
    slug,
    xpath_string,
)
from .recording import RecordedStep, Selector

TIMEOUT_S = 10

#: Counts the page's fetch and XHR calls; returns how many started so far.
NETWORK_WATCH = (
    "const w = window; if (!w.__workpilotNetwork) { "
    "const n = (w.__workpilotNetwork = { pending: 0, seen: 0 }); "
    "const start = () => { n.pending += 1; n.seen += 1; }; "
    "const end = () => { n.pending -= 1; }; "
    "const f = w.fetch; "
    "if (f) w.fetch = function (...a) { start(); return f.apply(w, a).finally(end); }; "
    "const send = XMLHttpRequest.prototype.send; "
    "XMLHttpRequest.prototype.send = function (...a) { start(); "
    'this.addEventListener("loadend", end); return send.apply(this, a); }; } '
    "return w.__workpilotNetwork.seen;"
)
#: True once a call started after ``arguments[0]`` and none is pending (or the page changed).
NETWORK_DONE = (
    "const n = window.__workpilotNetwork; "
    "return !n || (n.seen > arguments[0] && n.pending === 0);"
)

#: Roles whose accessible name is usually their text: the XPath of their elements.
_ROLE_XPATH = {
    "button": 'self::button or self::summary or @role="button" or '
    'self::input[@type="submit" or @type="button" or @type="reset"]',
    "link": 'self::a[@href] or @role="link"',
    "heading": "self::h1 or self::h2 or self::h3 or self::h4 or self::h5 "
    'or self::h6 or @role="heading"',
    "tab": '@role="tab"',
    "menuitem": '@role="menuitem"',
    "option": 'self::option or @role="option"',
}
_FIELD = "self::input or self::select or self::textarea"


def webdriver_locator(s: Selector, in_shadow: bool = False) -> tuple[str, str] | None:
    """``("css" | "xpath", selector)`` for WebDriver, or None when it has none."""
    if s.strategy == "testid":
        return "css", f'[data-testid="{css_string(s.value)}"]'
    if s.strategy == "placeholder":
        return "css", f'[placeholder="{css_string(s.value)}"]'
    if s.strategy == "css":
        return "css", s.value
    if in_shadow:
        return None
    x = xpath_string(s.value)
    if s.strategy == "text":
        return (
            "xpath",
            f"//*[normalize-space(.)={x}][not(.//*[normalize-space(.)={x}])]",
        )
    if s.strategy == "label":
        return "xpath", (
            f"//*[@id=//label[normalize-space(.)={x}]/@for]"
            f" | //label[normalize-space(.)={x}]//*[{_FIELD}]"
            f" | //*[@aria-labelledby=//*[normalize-space(.)={x}]/@id]"
        )
    role = _ROLE_XPATH.get(s.role)
    if role is None:
        return None
    return "xpath", (
        f"//*[({role}) and (normalize-space(.)={x} or @aria-label={x} or @value={x})]"
    )


def _locator(step: RecordedStep) -> tuple[str, str] | None:
    return next(
        (
            loc
            for loc in (webdriver_locator(s, bool(step.shadow)) for s in step.selectors)
            if loc is not None
        ),
        None,
    )


@dataclass(frozen=True)
class _Dialect:
    """How one language spells each piece of a WebDriver test."""

    navigate: Callable[[str], str]
    locate: Callable[[RecordedStep, tuple[str, str]], str]
    #: The located element (the ``locate`` call) as an expression.
    use: Callable[[str], str]
    action: Callable[[RecordedStep, str], str]
    bind: Callable[[str], str]
    seen: str
    wait_network: str
    wait_page: Callable[[str], str]
    skip: str
    #: Open and close a block around a step that binds a name, if any.
    block: tuple[str, str] | None = None


def _steps(steps: list[RecordedStep], d: _Dialect) -> tuple[list[str], int]:
    lines: list[str] = []
    skipped = 0
    for step in steps:
        if step.kind == "navigate":
            lines.append(d.navigate(step.url))
            continue
        loc = _locator(step)
        if loc is None:
            skipped += 1
            lines.append(d.skip)
            continue
        found = d.locate(step, loc)
        if step.wait_request:
            body = [
                d.bind(found),
                d.seen,
                d.action(step, "element"),
                d.wait_network,
            ]
            if d.block:
                lines += [d.block[0], *(f"\t{b}" for b in body), d.block[1]]
            else:
                lines += body
        else:
            lines.append(d.action(step, d.use(found)))
        if step.wait_url:
            lines.append(d.wait_page(step.wait_url))
    return lines, skipped


def _value(step: RecordedStep, quote: Callable[[str], str], secret: str) -> str:
    return (
        secret.format(quote(step.secret_env)) if step.secret_env else quote(step.value)
    )


# --- Selenium, Python --------------------------------------------------------------


def _py_locate(step: RecordedStep, loc: tuple[str, str]) -> str:
    by = "By.CSS_SELECTOR" if loc[0] == "css" else "By.XPATH"
    args = ["driver", by, py_literal(loc[1])]
    if step.frames:
        args.append("frames=[" + ", ".join(map(py_literal, step.frames)) + "]")
    if step.shadow:
        args.append("hosts=[" + ", ".join(map(py_literal, step.shadow)) + "]")
    if step.wait_visible:
        args.append("visible=True")
    return f"locate({', '.join(args)})"


def _py_action(step: RecordedStep, el: str) -> str:
    value = _value(step, py_literal, "os.environ[{}]")
    if step.kind == "click":
        return f"{el}.click()"
    if step.kind == "fill":
        return f"fill({el}, {value})"
    if step.kind == "select":
        return f"Select({el}).select_by_value({value})"
    if step.kind == "press":
        return f"{el}.send_keys(Keys.{'ENTER' if step.key == 'Enter' else 'ESCAPE'})"
    return f"expect_text(driver, {el}, {py_literal(step.text)})"


_PYTHON = _Dialect(
    navigate=lambda url: f"driver.get({py_literal(url)})",
    locate=_py_locate,
    use=lambda found: found,
    action=_py_action,
    bind=lambda found: f"element = {found}",
    seen="seen = network_seen(driver)",
    wait_network="wait_for_network(driver, seen)",
    wait_page=lambda url: f"wait_for_page(driver, {py_literal(url)})",
    skip="# step skipped: no selector Selenium can express",
)

_PYTHON_HELPERS = f'''TIMEOUT = {TIMEOUT_S}
#: Counts the page's fetch and XHR calls, to wait for the ones an action starts.
NETWORK_WATCH = {py_literal(NETWORK_WATCH)}
NETWORK_DONE = {py_literal(NETWORK_DONE)}


@pytest.fixture
def driver():
    browser = webdriver.Chrome()
    yield browser
    browser.quit()


def locate(driver, by, value, frames=(), hosts=(), visible=False):
    """The element, once it is there: down its frames, then its shadow roots."""
    driver.switch_to.default_content()
    for frame in frames:
        WebDriverWait(driver, TIMEOUT).until(
            EC.frame_to_be_available_and_switch_to_it((By.CSS_SELECTOR, frame))
        )
    context = driver
    for host in hosts:
        context = WebDriverWait(driver, TIMEOUT).until(
            lambda _, scope=context, css=host: scope.find_element(By.CSS_SELECTOR, css)
        ).shadow_root

    def found(_):
        element = context.find_element(by, value)
        return element if element.is_displayed() or not visible else False

    return WebDriverWait(driver, TIMEOUT).until(found)


def fill(element, value):
    element.clear()
    element.send_keys(value)


def expect_text(driver, element, text):
    WebDriverWait(driver, TIMEOUT).until(lambda _: text in element.text)


def network_seen(driver):
    return driver.execute_script(NETWORK_WATCH)


def wait_for_network(driver, seen):
    WebDriverWait(driver, TIMEOUT).until(
        lambda d: d.execute_script(NETWORK_DONE, seen)
    )


def wait_for_page(driver, url):
    WebDriverWait(driver, TIMEOUT).until(
        lambda d: d.current_url.split("#")[0].split("?")[0] == url
    )
'''


def selenium_python(
    name: str, steps: list[RecordedStep], env: list[str]
) -> tuple[str, int]:
    body, skipped = _steps(steps, _PYTHON)
    lines = [
        f'"""Recorded with the WorkPilot Browser Agent: {slug(name, " ")}."""',
        "",
    ]
    if env:
        lines += ["import os", ""]
    lines += [
        "import pytest",
        "from selenium import webdriver",
        "from selenium.webdriver.common.by import By",
        "from selenium.webdriver.common.keys import Keys",
        "from selenium.webdriver.support import expected_conditions as EC",
        "from selenium.webdriver.support.select import Select",
        "from selenium.webdriver.support.ui import WebDriverWait",
        "",
        *_PYTHON_HELPERS.splitlines(),
        "",
        "",
    ]
    if env:
        lines.append("# Secrets are read from the environment: " + ", ".join(env) + ".")
    lines.append(f"def test_{slug(name, '_')}(driver) -> None:")
    lines += [f"    {line}" for line in body] or ["    pass"]
    return "\n".join(lines) + "\n", skipped


# --- Selenium, Java ----------------------------------------------------------------


def _java_array(items: list[str]) -> str:
    return "new String[] {" + ", ".join(map(java_literal, items)) + "}"


def _java_locate(step: RecordedStep, loc: tuple[str, str]) -> str:
    by = f"By.{'cssSelector' if loc[0] == 'css' else 'xpath'}({java_literal(loc[1])})"
    if not (step.frames or step.shadow or step.wait_visible):
        return f"locate({by})"
    return (
        f"locate({by}, {_java_array(step.frames)}, {_java_array(step.shadow)}, "
        f"{'true' if step.wait_visible else 'false'})"
    )


def _java_action(step: RecordedStep, el: str) -> str:
    value = _value(step, java_literal, "secret({})")
    if step.kind == "click":
        return f"{el}.click();"
    if step.kind == "fill":
        return f"fill({el}, {value});"
    if step.kind == "select":
        return f"new Select({el}).selectByValue({value});"
    if step.kind == "press":
        return f"{el}.sendKeys(Keys.{'ENTER' if step.key == 'Enter' else 'ESCAPE'});"
    return f"expectText({el}, {java_literal(step.text)});"


_JAVA = _Dialect(
    navigate=lambda url: f"driver.get({java_literal(url)});",
    locate=_java_locate,
    use=lambda found: found,
    action=_java_action,
    bind=lambda found: f"WebElement element = {found};",
    seen="long seen = networkSeen();",
    wait_network="waitForNetwork(seen);",
    wait_page=lambda url: f"waitForPage({java_literal(url)});",
    skip="// step skipped: no selector Selenium can express",
    block=("{", "}"),
)

_JAVA_IMPORTS = [
    "import java.time.Duration;",
    "import org.junit.jupiter.api.AfterEach;",
    "import org.junit.jupiter.api.BeforeEach;",
    "import org.junit.jupiter.api.DisplayName;",
    "import org.junit.jupiter.api.Test;",
    "import org.openqa.selenium.By;",
    "import org.openqa.selenium.JavascriptExecutor;",
    "import org.openqa.selenium.Keys;",
    "import org.openqa.selenium.SearchContext;",
    "import org.openqa.selenium.WebDriver;",
    "import org.openqa.selenium.WebElement;",
    "import org.openqa.selenium.chrome.ChromeDriver;",
    "import org.openqa.selenium.support.ui.ExpectedConditions;",
    "import org.openqa.selenium.support.ui.Select;",
    "import org.openqa.selenium.support.ui.WebDriverWait;",
]

_JAVA_HELPERS = f"""\tprivate static final String NETWORK_WATCH = {java_literal(NETWORK_WATCH)};
\tprivate static final String NETWORK_DONE = {java_literal(NETWORK_DONE)};

\tprivate WebDriver driver;
\tprivate WebDriverWait wait;

\t@BeforeEach
\tvoid openBrowser() {{
\t\tdriver = new ChromeDriver();
\t\twait = new WebDriverWait(driver, Duration.ofSeconds({TIMEOUT_S}));
\t}}

\t@AfterEach
\tvoid closeBrowser() {{
\t\tdriver.quit();
\t}}

\tprivate WebElement locate(By by) {{
\t\treturn locate(by, new String[0], new String[0], false);
\t}}

\t/** The element, once it is there: down its frames, then its shadow roots. */
\tprivate WebElement locate(By by, String[] frames, String[] hosts, boolean visible) {{
\t\tdriver.switchTo().defaultContent();
\t\tfor (String frame : frames) {{
\t\t\twait.until(ExpectedConditions.frameToBeAvailableAndSwitchToIt(By.cssSelector(frame)));
\t\t}}
\t\tSearchContext context = driver;
\t\tfor (String host : hosts) {{
\t\t\tSearchContext scope = context;
\t\t\tcontext = wait.until(d -> scope.findElement(By.cssSelector(host))).getShadowRoot();
\t\t}}
\t\tSearchContext root = context;
\t\treturn wait.until(d -> {{
\t\t\tWebElement element = root.findElement(by);
\t\t\treturn visible && !element.isDisplayed() ? null : element;
\t\t}});
\t}}

\tprivate static void fill(WebElement element, String value) {{
\t\telement.clear();
\t\telement.sendKeys(value);
\t}}

\tprivate void expectText(WebElement element, String text) {{
\t\twait.until(d -> element.getText().contains(text));
\t}}

\tprivate long networkSeen() {{
\t\treturn ((Number) ((JavascriptExecutor) driver).executeScript(NETWORK_WATCH)).longValue();
\t}}

\tprivate void waitForNetwork(long seen) {{
\t\twait.until(d -> Boolean.TRUE.equals(((JavascriptExecutor) d).executeScript(NETWORK_DONE, seen)));
\t}}

\tprivate void waitForPage(String url) {{
\t\twait.until(d -> url.equals(d.getCurrentUrl().split("[?#]", 2)[0]));
\t}}
"""

_JAVA_SECRET = """
\t// Secrets are read from the environment: {names}.
\tprivate static String secret(String name) {{
\t\tString value = System.getenv(name);
\t\tif (value == null || value.isEmpty()) {{
\t\t\tthrow new IllegalStateException("Set " + name + " to run this test");
\t\t}}
\t\treturn value;
\t}}
"""


def selenium_java(
    name: str, steps: list[RecordedStep], env: list[str]
) -> tuple[str, int]:
    body, skipped = _steps(steps, _JAVA)
    lines = [
        "package e2e;",
        "",
        *_JAVA_IMPORTS,
        "",
        "/** Recorded with the WorkPilot Browser Agent. */",
        f"class {pascal(name)}Test {{",
        *_JAVA_HELPERS.splitlines(),
    ]
    if env:
        lines += _JAVA_SECRET.format(names=", ".join(env)).splitlines()
    lines += [
        "",
        "\t@Test",
        f"\t@DisplayName({java_literal(name)})",
        "\tvoid replaysTheRecordedSteps() {",
        *(f"\t\t{line}" for line in body),
        "\t}",
        "}",
    ]
    return "\n".join(lines) + "\n", skipped


# --- WebdriverIO -------------------------------------------------------------------

#: WebDriver key codes (W3C): Enter, Escape.
_WDIO_KEYS = {"Enter": "", "Escape": ""}


def _js_locate(step: RecordedStep, loc: tuple[str, str]) -> str:
    options = []
    if step.frames:
        options.append("frames: [" + ", ".join(map(literal, step.frames)) + "]")
    if step.shadow:
        options.append("hosts: [" + ", ".join(map(literal, step.shadow)) + "]")
    if step.wait_visible:
        options.append("visible: true")
    extra = f", {{ {', '.join(options)} }}" if options else ""
    return f"locate({literal(loc[1])}{extra})"


def _js_action(step: RecordedStep, el: str) -> str:
    value = _value(step, literal, "secret({})")
    if step.kind == "click":
        return f"await {el}.click();"
    if step.kind == "fill":
        return f"await {el}.setValue({value});"
    if step.kind == "select":
        return f'await {el}.selectByAttribute("value", {value});'
    if step.kind == "press":
        return f"await {el}.addValue({literal(_WDIO_KEYS[step.key])});"
    return (
        f"await expect({el}).toHaveText(expect.stringContaining({literal(step.text)}));"
    )


_JAVASCRIPT = _Dialect(
    navigate=lambda url: f"await browser.url({literal(url)});",
    locate=_js_locate,
    use=lambda found: f"(await {found})",
    action=_js_action,
    bind=lambda found: f"const element = await {found};",
    seen="const seen = await networkSeen();",
    wait_network="await waitForNetwork(seen);",
    wait_page=lambda url: f"await waitForPage({literal(url)});",
    skip="// step skipped: no selector WebdriverIO can express",
    block=("{", "}"),
)

_JS_HELPERS = f"""const TIMEOUT = {TIMEOUT_S * 1000};
// Counts the page's fetch and XHR calls, to wait for the ones an action starts.
const NETWORK_WATCH = {literal(NETWORK_WATCH)};
const NETWORK_DONE = {literal(NETWORK_DONE)};

/** The element, once it is there: down its frames, then its shadow roots. */
async function locate(selector, {{ frames = [], hosts = [], visible = false }} = {{}}) {{
\tawait browser.switchToFrame(null);
\tfor (const frame of frames) {{
\t\tconst element = await $(frame);
\t\tawait element.waitForExist({{ timeout: TIMEOUT }});
\t\tawait browser.switchToFrame(element);
\t}}
\tlet scope = null;
\tfor (const host of hosts) {{
\t\tscope = scope ? await scope.shadow$(host) : await $(host);
\t\tawait scope.waitForExist({{ timeout: TIMEOUT }});
\t}}
\tconst element = scope ? await scope.shadow$(selector) : await $(selector);
\tif (visible) await element.waitForDisplayed({{ timeout: TIMEOUT }});
\telse await element.waitForExist({{ timeout: TIMEOUT }});
\treturn element;
}}

async function networkSeen() {{
\treturn browser.execute(NETWORK_WATCH);
}}

async function waitForNetwork(seen) {{
\tawait browser.waitUntil(() => browser.execute(NETWORK_DONE, seen), {{ timeout: TIMEOUT }});
}}

async function waitForPage(url) {{
\tawait browser.waitUntil(async () => (await browser.getUrl()).split(/[?#]/)[0] === url, {{
\t\ttimeout: TIMEOUT,
\t}});
}}
"""

_JS_SECRET = """
// Secrets are read from the environment: {names}.
function secret(name) {{
\tconst value = process.env[name];
\tif (!value) throw new Error("Set " + name + " to run this test");
\treturn value;
}}
"""


def webdriverio(
    name: str, steps: list[RecordedStep], env: list[str]
) -> tuple[str, int]:
    body, skipped = _steps(steps, _JAVASCRIPT)
    lines = [
        'import { $, browser, expect } from "@wdio/globals";',
        "",
        *_JS_HELPERS.splitlines(),
    ]
    if env:
        lines += _JS_SECRET.format(names=", ".join(env)).splitlines()
    lines += [
        "",
        f"describe({literal(name)}, () => {{",
        f"\tit({literal('replays the recorded steps')}, async () => {{",
        *(f"\t\t{line}" for line in body),
        "\t});",
        "});",
    ]
    return "\n".join(lines) + "\n", skipped

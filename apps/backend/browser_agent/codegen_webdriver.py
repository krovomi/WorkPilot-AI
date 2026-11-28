"""
A recording as a WebDriver test: Selenium (Python with pytest, Java with
JUnit 5) and WebdriverIO (JavaScript, Mocha) here; Selenium in C#, Ruby and
JavaScript and WebdriverIO in TypeScript in ``codegen_webdriver_langs``.

They share one walk over the steps (:func:`walk`) and differ only by their
:class:`Dialect`: how a literal is written, how an element is found, how an
action, a binding and a wait are spelled. Page text enters through the
dialect's literal function only (``codegen_text``).

WebDriver finds an element by CSS or XPath. A selector of the recording
becomes one of those (:func:`webdriver_locator`): a test id or a placeholder
as a CSS attribute selector, a label, a text or a role named by its text as
an XPath, the XPath string built by ``xpath_string``. Inside a shadow root
WebDriver only finds by CSS, so those steps take their first CSS selector
(the recorder always gives one, its CSS path last). A selector that matches
several elements (``nth``) keeps its place when the query finds the same
elements in the same order as the page counted them: a placeholder (the CSS
attribute selector matches exactly those) and a text (the XPath keeps the
innermost element holding it, as the page did; both in document order). A
role or a label is counted by its accessible name, which XPath does not
compute: those pass to the next selector, and the CSS path last is unique.

A hover, a drag (W3C actions; drag events dispatched by a script of this
module when the page listened to those, which Chrome does not fire for W3C
actions), a scroll (a script with the two numbers), the options of a
multiple list and the answer to a dialog (the alert is waited for after the
action) are each one call of the dialect.

Nothing pauses for a fixed time: each lookup waits until the element is there
(and shows, when it appeared after the previous action); a request the action
started is waited for by counting the page's ``fetch`` and XHR calls (a
script of this module, not of the page); a loading indicator, until the
first element its selector matches in the top document is gone or hidden;
the page an action led to, by its URL without query or fragment.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass

from .codegen_data import JAVA_RESOURCES, TestData, file_name, py_data_lines
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

#: Fires the drag events of the HTML drag and drop API, from arguments[0] to [1].
DRAG_HTML5 = (
    "const [source, target] = arguments; const data = new DataTransfer(); "
    "const fire = (el, type) => el.dispatchEvent(new DragEvent(type, "
    "{ bubbles: true, cancelable: true, dataTransfer: data })); "
    'fire(source, "dragstart"); fire(target, "dragenter"); '
    'fire(target, "dragover"); fire(target, "drop"); fire(source, "dragend");'
)
#: Scrolls arguments[0] (an element) to arguments[1], arguments[2].
SCROLL_ELEMENT = "arguments[0].scrollTo(arguments[1], arguments[2]);"
SCROLL_WINDOW = "window.scrollTo(arguments[0], arguments[1]);"
#: Picks exactly the options whose values are in arguments[1], as a person does.
SELECT_VALUES = (
    "const [list, values] = arguments; "
    "for (const option of list.options) option.selected = values.includes(option.value); "
    'list.dispatchEvent(new Event("input", { bubbles: true })); '
    'list.dispatchEvent(new Event("change", { bubbles: true }));'
)

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


#: The strategies whose place WebDriver finds as the page counted it.
_PLACED = ("placeholder", "text")

Locator = tuple[str, str, int | None]


def webdriver_locator(s: Selector, in_shadow: bool = False) -> tuple[str, str] | None:
    """``("css" | "xpath", selector)`` for WebDriver, or None when it has none.

    A selector with a place (``nth``) has none here: see :func:`placed_locator`.
    """
    found = placed_locator(s, in_shadow)
    return None if found is None or found[2] is not None else found[:2]


def placed_locator(s: Selector, in_shadow: bool = False) -> Locator | None:
    """``(how, selector, nth)``: the element is the ``nth`` match when set."""
    if s.nth is not None and s.strategy not in _PLACED:
        return None
    base = _query(s, in_shadow)
    return None if base is None else (base[0], base[1], s.nth)


def _query(s: Selector, in_shadow: bool) -> tuple[str, str] | None:
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


def first_locator(step: RecordedStep, selectors: list[Selector]) -> Locator | None:
    return next(
        (
            loc
            for loc in (placed_locator(s, bool(step.shadow)) for s in selectors)
            if loc is not None
        ),
        None,
    )


def frame_hops(step: RecordedStep) -> list[list[str]]:
    """Each iframe as the shadow hosts it sits in, then its own CSS."""
    hosts = step.frame_shadow or [[] for _ in step.frames]
    return [[*above, frame] for above, frame in zip(hosts, step.frames, strict=True)]


def uses(steps: list[RecordedStep]) -> set[str]:
    """What the steps need beyond the base helpers: drag, dialog, scroll, values."""
    needs: set[str] = set()
    for step in steps:
        if step.kind == "drag":
            needs.add("drag-" + step.drag_mode)
        if step.kind == "scroll":
            needs.add("scroll-element" if step.selectors else "scroll-window")
        if step.kind == "hover":
            needs.add("hover")
        if step.values and not step.secret_env:
            needs.add("values")
        if step.dialog:
            needs.add("dialog")
    return needs


@dataclass(frozen=True)
class Dialect:
    """How one language spells each piece of a WebDriver test."""

    navigate: Callable[[str], str]
    locate: Callable[[RecordedStep, Locator], str]
    #: The located element (the ``locate`` call) as an expression.
    use: Callable[[str], str]
    #: The action on the element, and on the element dropped onto (``drag``).
    action: Callable[[RecordedStep, str, str], str]
    bind: Callable[[str], str]
    seen: str
    wait_network: str
    wait_page: Callable[[str], str]
    wait_hidden: Callable[[str], str]
    skip: str
    scroll_window: Callable[[int, int], str]
    #: Answers the dialog the action opened: accept, and the text of a prompt.
    dialog: Callable[[bool, str | None], str]
    #: Open and close a block around a step that binds a name, if any.
    block: tuple[str, str] | None = None


def _dialog(step: RecordedStep, d: Dialect) -> list[str]:
    answer = step.dialog
    if answer is None:
        return []
    text = answer.text if answer.accept and answer.type == "prompt" else None
    return [d.dialog(answer.accept, text)]


def walk(steps: list[RecordedStep], d: Dialect) -> tuple[list[str], int]:
    """The body of the test in dialect ``d``, and how many steps it skipped."""
    lines: list[str] = []
    skipped = 0
    for step in steps:
        if step.kind == "navigate":
            lines.append(d.navigate(step.url))
            continue
        if step.kind == "scroll" and not step.selectors:
            lines += [d.scroll_window(step.scroll_x, step.scroll_y), *_dialog(step, d)]
            continue
        loc = first_locator(step, step.selectors)
        drop = first_locator(step, step.drop) if step.kind == "drag" else None
        if loc is None or (step.kind == "drag" and drop is None):
            skipped += 1
            lines.append(d.skip)
            continue
        found = d.locate(step, loc)
        target = d.use(d.locate(_dropped(step), drop)) if drop else ""
        if step.wait_request:
            body = [
                d.bind(found),
                d.seen,
                d.action(step, "element", target),
                *_dialog(step, d),
                d.wait_network,
            ]
            if d.block:
                lines += [d.block[0], *(f"\t{b}" for b in body), d.block[1]]
            else:
                lines += body
        else:
            lines += [d.action(step, d.use(found), target), *_dialog(step, d)]
        if step.wait_hidden:
            lines.append(d.wait_hidden(step.wait_hidden))
        if step.wait_url:
            lines.append(d.wait_page(step.wait_url))
    return lines, skipped


def _dropped(step: RecordedStep) -> RecordedStep:
    """The element a drag drops onto: in the same frame and shadow roots."""
    return RecordedStep(
        step.id,
        "click",
        step.drop,
        frames=step.frames,
        shadow=step.shadow,
        frame_shadow=step.frame_shadow,
    )


def typed_value(
    step: RecordedStep,
    quote: Callable[[str], str],
    secret: str,
    data: Callable[[str], str],
) -> str:
    """The value a fill or a list takes: its secret, its key in the data, or itself.

    A secret is read from the variable its key in the data names.
    """
    if step.secret_env:
        return secret.format(data(step.data_key))
    return data(step.data_key) if step.data_key else quote(step.value)


# --- Selenium, Python --------------------------------------------------------------


def _py_list(items: list[str]) -> str:
    return "[" + ", ".join(map(py_literal, items)) + "]"


def _py_locate(step: RecordedStep, loc: Locator) -> str:
    by = "By.CSS_SELECTOR" if loc[0] == "css" else "By.XPATH"
    args = ["driver", by, py_literal(loc[1])]
    if step.frame_shadow:
        args.append("frames=[" + ", ".join(map(_py_list, frame_hops(step))) + "]")
    elif step.frames:
        args.append("frames=[" + ", ".join(map(py_literal, step.frames)) + "]")
    if step.shadow:
        args.append("hosts=[" + ", ".join(map(py_literal, step.shadow)) + "]")
    if step.wait_visible:
        args.append("visible=True")
    if loc[2] is not None:
        args.append(f"nth={loc[2]}")
    return f"locate({', '.join(args)})"


def _py_action(step: RecordedStep, el: str, target: str) -> str:
    value = typed_value(
        step, py_literal, "os.environ[{}]", lambda key: f"TEST_DATA[{py_literal(key)}]"
    )
    if step.kind == "click":
        return f"{el}.click()"
    if step.kind == "hover":
        return f"ActionChains(driver).move_to_element({el}).perform()"
    if step.kind == "scroll":
        return (
            f"driver.execute_script(SCROLL_ELEMENT, {el}, "
            f"{step.scroll_x}, {step.scroll_y})"
        )
    if step.kind == "drag" and step.drag_mode == "html5":
        return f"driver.execute_script(DRAG_HTML5, {el}, {target})"
    if step.kind == "drag":
        return f"ActionChains(driver).drag_and_drop({el}, {target}).perform()"
    if step.kind == "select" and step.values and not step.secret_env:
        return f"driver.execute_script(SELECT_VALUES, {el}, {_py_list(step.values)})"
    if step.kind == "fill":
        return f"fill({el}, {value})"
    if step.kind == "select":
        return f"Select({el}).select_by_value({value})"
    if step.kind == "press":
        return f"{el}.send_keys(Keys.{'ENTER' if step.key == 'Enter' else 'ESCAPE'})"
    return f"expect_text(driver, {el}, {py_literal(step.text)})"


_PYTHON = Dialect(
    navigate=lambda url: f"driver.get({py_literal(url)})",
    locate=_py_locate,
    use=lambda found: found,
    action=_py_action,
    bind=lambda found: f"element = {found}",
    seen="seen = network_seen(driver)",
    wait_network="wait_for_network(driver, seen)",
    wait_page=lambda url: f"wait_for_page(driver, {py_literal(url)})",
    wait_hidden=lambda css: f"wait_for_hidden(driver, {py_literal(css)})",
    skip="# step skipped: no selector Selenium can express",
    scroll_window=lambda x, y: f"scroll_window(driver, {x}, {y})",
    dialog=lambda accept, text: (
        f"answer_dialog(driver, {accept}"
        + ("" if text is None else f", {py_literal(text)}")
        + ")"
    ),
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


def shadow_scope(driver, hosts):
    """The innermost of the open shadow roots of hosts, outermost first."""
    context = driver
    for host in hosts:
        context = WebDriverWait(driver, TIMEOUT).until(
            lambda _, scope=context, css=host: scope.find_element(By.CSS_SELECTOR, css)
        ).shadow_root
    return context


def locate(driver, by, value, frames=(), hosts=(), visible=False, nth=None):
    """The element (the nth match), once it is there: down its frames,
    each in the shadow roots it sits in, then its own shadow roots."""
    driver.switch_to.default_content()
    for frame in frames:
        hops = [frame] if isinstance(frame, str) else list(frame)
        scope = shadow_scope(driver, hops[:-1])
        element = WebDriverWait(driver, TIMEOUT).until(
            lambda _, s=scope, css=hops[-1]: s.find_element(By.CSS_SELECTOR, css)
        )
        driver.switch_to.frame(element)
    context = shadow_scope(driver, hosts)

    def found(_):
        matches = context.find_elements(by, value)
        if len(matches) <= (nth or 0):
            return False
        element = matches[nth or 0]
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


def wait_for_hidden(driver, css):
    """The loading indicator is gone or hidden, in the top document."""
    driver.switch_to.default_content()
    WebDriverWait(driver, TIMEOUT).until(
        EC.invisibility_of_element_located((By.CSS_SELECTOR, css))
    )
'''

_PYTHON_EXTRA = {
    "drag-html5": f"\n\nDRAG_HTML5 = {py_literal(DRAG_HTML5)}",
    "scroll-element": f"\n\nSCROLL_ELEMENT = {py_literal(SCROLL_ELEMENT)}",
    "values": f"\n\nSELECT_VALUES = {py_literal(SELECT_VALUES)}",
    "scroll-window": f"""

def scroll_window(driver, x, y):
    driver.switch_to.default_content()
    driver.execute_script({py_literal(SCROLL_WINDOW)}, x, y)""",
    "dialog": '''

def answer_dialog(driver, accept, text=None):
    """Answers the dialog the last action opened, as it was answered when recorded."""
    alert = WebDriverWait(driver, TIMEOUT).until(EC.alert_is_present())
    if text is not None:
        alert.send_keys(text)
    if accept:
        alert.accept()
    else:
        alert.dismiss()''',
}


def extras(table: dict[str, str], needs: set[str]) -> list[str]:
    """The helper lines ``needs`` asks for, in the table's order."""
    return [
        line
        for key, code in table.items()
        if key in needs
        for line in code.splitlines()
    ]


def selenium_python(
    name: str, steps: list[RecordedStep], env: list[str], data: TestData
) -> tuple[str, int]:
    body, skipped = walk(steps, _PYTHON)
    needs = uses(steps)
    lines = [
        f'"""Recorded with the WorkPilot Browser Agent: {slug(name, " ")}."""',
        "",
    ]
    std = (
        (["import json"] if data else [])
        + (["import os"] if env else [])
        + (["from pathlib import Path"] if data else [])
    )
    if std:
        lines += [*std, ""]
    lines += [
        "import pytest",
        "from selenium import webdriver",
        *(
            ["from selenium.webdriver.common.action_chains import ActionChains"]
            if needs & {"hover", "drag-pointer"}
            else []
        ),
        "from selenium.webdriver.common.by import By",
        "from selenium.webdriver.common.keys import Keys",
        "from selenium.webdriver.support import expected_conditions as EC",
        "from selenium.webdriver.support.select import Select",
        "from selenium.webdriver.support.ui import WebDriverWait",
        "",
        *_PYTHON_HELPERS.splitlines(),
        *extras(_PYTHON_EXTRA, needs),
        "",
        "",
        *py_data_lines(name, data),
    ]
    if env:
        lines.append("# Secrets are read from the environment: " + ", ".join(env) + ".")
    lines.append(f"def test_{slug(name, '_')}(driver) -> None:")
    lines += [f"    {line}" for line in body] or ["    pass"]
    return "\n".join(lines) + "\n", skipped


# --- Selenium, Java ----------------------------------------------------------------


def _java_array(items: list[str]) -> str:
    return "new String[] {" + ", ".join(map(java_literal, items)) + "}"


def _java_locate(step: RecordedStep, loc: Locator) -> str:
    by = f"By.{'cssSelector' if loc[0] == 'css' else 'xpath'}({java_literal(loc[1])})"
    if loc[2] is not None or step.frame_shadow:
        hops = ", ".join(
            "{" + ", ".join(map(java_literal, hop)) + "}" for hop in frame_hops(step)
        )
        return (
            f"locate({by}, new String[][] {{{hops}}}, {_java_array(step.shadow)}, "
            f"{'true' if step.wait_visible else 'false'}, "
            f"{-1 if loc[2] is None else loc[2]})"
        )
    if not (step.frames or step.shadow or step.wait_visible):
        return f"locate({by})"
    return (
        f"locate({by}, {_java_array(step.frames)}, {_java_array(step.shadow)}, "
        f"{'true' if step.wait_visible else 'false'})"
    )


def _java_action(step: RecordedStep, el: str, target: str) -> str:
    value = typed_value(
        step, java_literal, "secret({})", lambda key: f"data({java_literal(key)})"
    )
    if step.kind == "click":
        return f"{el}.click();"
    if step.kind == "hover":
        return f"new Actions(driver).moveToElement({el}).perform();"
    if step.kind == "scroll":
        return f"script(SCROLL_ELEMENT, {el}, {step.scroll_x}, {step.scroll_y});"
    if step.kind == "drag" and step.drag_mode == "html5":
        return f"script(DRAG_HTML5, {el}, {target});"
    if step.kind == "drag":
        return f"new Actions(driver).dragAndDrop({el}, {target}).perform();"
    if step.kind == "select" and step.values and not step.secret_env:
        values = "List.of(" + ", ".join(map(java_literal, step.values)) + ")"
        return f"script(SELECT_VALUES, {el}, {values});"
    if step.kind == "fill":
        return f"fill({el}, {value});"
    if step.kind == "select":
        return f"new Select({el}).selectByValue({value});"
    if step.kind == "press":
        return f"{el}.sendKeys(Keys.{'ENTER' if step.key == 'Enter' else 'ESCAPE'});"
    return f"expectText({el}, {java_literal(step.text)});"


_JAVA = Dialect(
    navigate=lambda url: f"driver.get({java_literal(url)});",
    locate=_java_locate,
    use=lambda found: found,
    action=_java_action,
    bind=lambda found: f"WebElement element = {found};",
    seen="long seen = networkSeen();",
    wait_network="waitForNetwork(seen);",
    wait_page=lambda url: f"waitForPage({java_literal(url)});",
    wait_hidden=lambda css: f"waitForHidden({java_literal(css)});",
    skip="// step skipped: no selector Selenium can express",
    scroll_window=lambda x, y: f"scrollWindow({x}, {y});",
    dialog=lambda accept, text: (
        f"answerDialog({'true' if accept else 'false'}, "
        f"{'null' if text is None else java_literal(text)});"
    ),
    block=("{", "}"),
)

_JAVA_IMPORTS = [
    "import java.time.Duration;",
    "import java.util.Arrays;",
    "import java.util.List;",
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

_ALERT = "import org.openqa.selenium.Alert;"
_CHROME = "import org.openqa.selenium.chrome.ChromeDriver;"
_ACTIONS = "import org.openqa.selenium.interactions.Actions;"

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

\tprivate WebElement locate(By by, String[] frames, String[] hosts, boolean visible) {{
\t\tString[][] hops = new String[frames.length][];
\t\tfor (int i = 0; i < frames.length; i++) {{
\t\t\thops[i] = new String[] {{frames[i]}};
\t\t}}
\t\treturn locate(by, hops, hosts, visible, -1);
\t}}

\t/**
\t * The element (the nth match, unless nth is -1), once it is there: down its frames,
\t * each in the shadow roots it sits in, then its own shadow roots.
\t */
\tprivate WebElement locate(By by, String[][] frames, String[] hosts, boolean visible, int nth) {{
\t\tdriver.switchTo().defaultContent();
\t\tfor (String[] hops : frames) {{
\t\t\tSearchContext scope = shadowScope(Arrays.copyOf(hops, hops.length - 1));
\t\t\tString css = hops[hops.length - 1];
\t\t\tWebElement frame = wait.until(d -> scope.findElement(By.cssSelector(css)));
\t\t\tdriver.switchTo().frame(frame);
\t\t}}
\t\tSearchContext root = shadowScope(hosts);
\t\tint index = Math.max(nth, 0);
\t\treturn wait.until(d -> {{
\t\t\tList<WebElement> matches = root.findElements(by);
\t\t\tif (matches.size() <= index) return null;
\t\t\tWebElement element = matches.get(index);
\t\t\treturn visible && !element.isDisplayed() ? null : element;
\t\t}});
\t}}

\tprivate SearchContext shadowScope(String[] hosts) {{
\t\tSearchContext context = driver;
\t\tfor (String host : hosts) {{
\t\t\tSearchContext scope = context;
\t\t\tcontext = wait.until(d -> scope.findElement(By.cssSelector(host))).getShadowRoot();
\t\t}}
\t\treturn context;
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

\t/** The loading indicator is gone or hidden, in the top document. */
\tprivate void waitForHidden(String css) {{
\t\tdriver.switchTo().defaultContent();
\t\twait.until(ExpectedConditions.invisibilityOfElementLocated(By.cssSelector(css)));
\t}}
"""

_JAVA_EXTRA = {
    "drag-html5": f"\tprivate static final String DRAG_HTML5 = {java_literal(DRAG_HTML5)};",
    "scroll-element": (
        f"\tprivate static final String SCROLL_ELEMENT = {java_literal(SCROLL_ELEMENT)};"
    ),
    "values": f"\tprivate static final String SELECT_VALUES = {java_literal(SELECT_VALUES)};",
    "script": """
\tprivate Object script(String code, Object... args) {
\t\treturn ((JavascriptExecutor) driver).executeScript(code, args);
\t}""",
    "scroll-window": f"""
\tprivate void scrollWindow(long x, long y) {{
\t\tdriver.switchTo().defaultContent();
\t\t((JavascriptExecutor) driver).executeScript({java_literal(SCROLL_WINDOW)}, x, y);
\t}}""",
    "dialog": """
\t/** Answers the dialog the last action opened, as it was answered when recorded. */
\tprivate void answerDialog(boolean accept, String text) {
\t\tAlert alert = wait.until(ExpectedConditions.alertIsPresent());
\t\tif (text != null) alert.sendKeys(text);
\t\tif (accept) alert.accept();
\t\telse alert.dismiss();
\t}""",
}

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


def java_data_lines(name: str, data: TestData) -> list[str]:
    """How a Java test reads its data: a JSON resource of its package, by key."""
    if not data:
        return []
    return [
        "",
        "\t/** The values typed while recording and the secrets' variables, from "
        f"{JAVA_RESOURCES}e2e/{file_name(name)}. */",
        "\tprivate static final Map<String, Object> TEST_DATA = "
        f"readTestData({java_literal(file_name(name))});",
        "",
        "\tprivate static Map<String, Object> readTestData(String file) {",
        f"\t\ttry (InputStream in = {pascal(name)}Test.class.getResourceAsStream(file)) {{",
        "\t\t\tif (in == null) {",
        '\t\t\t\tthrow new IllegalStateException(file + " is not on the test classpath");',
        "\t\t\t}",
        "\t\t\treturn new Json().toType(new String(in.readAllBytes(), "
        "StandardCharsets.UTF_8), Json.MAP_TYPE);",
        "\t\t} catch (IOException e) {",
        "\t\t\tthrow new UncheckedIOException(e);",
        "\t\t}",
        "\t}",
        "",
        "\tprivate static String data(String key) {",
        "\t\tObject value = TEST_DATA.get(key);",
        "\t\tif (!(value instanceof String)) {",
        '\t\t\tthrow new IllegalStateException(key + " is missing from the test data");',
        "\t\t}",
        "\t\treturn (String) value;",
        "\t}",
    ]


#: What reading the data takes in Java: the JDK, and Selenium's JSON reader.
_JAVA_DATA_IMPORTS = [
    "import java.io.IOException;",
    "import java.io.InputStream;",
    "import java.io.UncheckedIOException;",
    "import java.nio.charset.StandardCharsets;",
]
_JAVA_JSON = "import org.openqa.selenium.json.Json;"


def selenium_java(
    name: str, steps: list[RecordedStep], env: list[str], data: TestData
) -> tuple[str, int]:
    body, skipped = walk(steps, _JAVA)
    needs = uses(steps)
    if needs & {"drag-html5", "scroll-element", "values"}:
        needs.add("script")
    imports = [*_JAVA_IMPORTS]
    if data:
        imports[:0] = _JAVA_DATA_IMPORTS
        imports.insert(
            imports.index("import java.util.List;") + 1, "import java.util.Map;"
        )
        imports.insert(imports.index(_CHROME) + 1, _JAVA_JSON)
    if "dialog" in needs:
        imports.insert(imports.index("import org.openqa.selenium.By;"), _ALERT)
    if needs & {"hover", "drag-pointer"}:
        imports.insert(imports.index(_CHROME) + 1, _ACTIONS)
    lines = [
        "package e2e;",
        "",
        *imports,
        "",
        "/** Recorded with the WorkPilot Browser Agent. */",
        f"class {pascal(name)}Test {{",
        *_JAVA_HELPERS.splitlines(),
        *extras(_JAVA_EXTRA, needs),
        *java_data_lines(name, data),
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


# --- WebdriverIO (JavaScript, TypeScript) -------------------------------------------

#: WebDriver key codes (W3C): Enter, Escape.
_WDIO_KEYS = {"Enter": "", "Escape": ""}
_TYPED = re.compile(r"<<(.*?)>>", re.DOTALL)


def typed(code: str, ts: bool) -> str:
    """``code`` with its ``<<…>>`` parts kept (TypeScript) or dropped (JavaScript)."""
    return _TYPED.sub(lambda m: m.group(1) if ts else "", code)


def _js_list(items: list[str]) -> str:
    return "[" + ", ".join(map(literal, items)) + "]"


def _js_locate(step: RecordedStep, loc: Locator) -> str:
    options = []
    if step.frame_shadow:
        options.append("frames: [" + ", ".join(map(_js_list, frame_hops(step))) + "]")
    elif step.frames:
        options.append("frames: " + _js_list(step.frames))
    if step.shadow:
        options.append("hosts: " + _js_list(step.shadow))
    if step.wait_visible:
        options.append("visible: true")
    if loc[2] is not None:
        options.append(f"nth: {loc[2]}")
    extra = f", {{ {', '.join(options)} }}" if options else ""
    return f"locate({literal(loc[1])}{extra})"


def _js_action(step: RecordedStep, el: str, target: str) -> str:
    value = typed_value(step, literal, "secret({})", js_data)
    if step.kind == "click":
        return f"await {el}.click();"
    if step.kind == "hover":
        return f"await {el}.moveTo();"
    if step.kind == "scroll":
        return (
            f"await browser.execute(SCROLL_ELEMENT, {el}, "
            f"{step.scroll_x}, {step.scroll_y});"
        )
    if step.kind == "drag" and step.drag_mode == "html5":
        return f"await browser.execute(DRAG_HTML5, {el}, {target});"
    if step.kind == "drag":
        return f"await {el}.dragAndDrop({target});"
    if step.kind == "select" and step.values and not step.secret_env:
        return f"await browser.execute(SELECT_VALUES, {el}, {_js_list(step.values)});"
    if step.kind == "fill":
        return f"await {el}.setValue({value});"
    if step.kind == "select":
        return f'await {el}.selectByAttribute("value", {value});'
    if step.kind == "press":
        return f"await {el}.addValue({literal(_WDIO_KEYS[step.key])});"
    return (
        f"await expect({el}).toHaveText(expect.stringContaining({literal(step.text)}));"
    )


WDIO = Dialect(
    navigate=lambda url: f"await browser.url({literal(url)});",
    locate=_js_locate,
    use=lambda found: f"(await {found})",
    action=_js_action,
    bind=lambda found: f"const element = await {found};",
    seen="const seen = await networkSeen();",
    wait_network="await waitForNetwork(seen);",
    wait_page=lambda url: f"await waitForPage({literal(url)});",
    wait_hidden=lambda css: f"await waitForHidden({literal(css)});",
    skip="// step skipped: no selector WebdriverIO can express",
    scroll_window=lambda x, y: f"await scrollWindow({x}, {y});",
    dialog=lambda accept, text: (
        f"await answerDialog({'true' if accept else 'false'}"
        + ("" if text is None else f", {literal(text)}")
        + ");"
    ),
    block=("{", "}"),
)

_JS_HELPERS = f"""const TIMEOUT = {TIMEOUT_S * 1000};
// Counts the page's fetch and XHR calls, to wait for the ones an action starts.
const NETWORK_WATCH = {literal(NETWORK_WATCH)};
const NETWORK_DONE = {literal(NETWORK_DONE)};
<<
/** An iframe: its CSS, or the shadow hosts it sits in and then its CSS. */
type Frame = string | string[];
>>
/** The innermost of the open shadow roots of hosts, outermost first (null: the document). */
async function shadowScope(hosts<<: string[]>>) {{
\tlet scope<<: WebdriverIO.Element | null>> = null;
\tfor (const host of hosts) {{
\t\tscope = scope ? await scope.shadow$(host) : await $(host);
\t\tawait scope.waitForExist({{ timeout: TIMEOUT }});
\t}}
\treturn scope;
}}

/**
 * The element (the nth match), once it is there: down its frames, each in the
 * shadow roots it sits in, then its own shadow roots.
 */
async function locate(
\tselector<<: string>>,
\t{{ frames = [], hosts = [], visible = false, nth = 0 }}<<: {{ frames?: Frame[]; hosts?: string[]; visible?: boolean; nth?: number }}>> = {{}},
) {{
\tawait browser.switchToFrame(null);
\tfor (const frame of frames) {{
\t\tconst hops = typeof frame === "string" ? [frame] : frame;
\t\tconst scope = await shadowScope(hops.slice(0, -1));
\t\tconst css = hops[hops.length - 1];
\t\tconst element = scope ? await scope.shadow$(css) : await $(css);
\t\tawait element.waitForExist({{ timeout: TIMEOUT }});
\t\tawait browser.switchToFrame(element);
\t}}
\tconst scope = await shadowScope(hosts);
\tconst matches = async () => (scope ? await scope.shadow$$(selector) : await $$(selector));
\tawait browser.waitUntil(async () => (await matches()).length > nth, {{ timeout: TIMEOUT }});
\tconst element = (await matches())[nth];
\tif (visible) await element.waitForDisplayed({{ timeout: TIMEOUT }});
\treturn element;
}}

async function networkSeen() {{
\treturn browser.execute(NETWORK_WATCH);
}}

async function waitForNetwork(seen<<: number>>) {{
\tawait browser.waitUntil(() => browser.execute(NETWORK_DONE, seen), {{ timeout: TIMEOUT }});
}}

async function waitForPage(url<<: string>>) {{
\tawait browser.waitUntil(async () => (await browser.getUrl()).split(/[?#]/)[0] === url, {{
\t\ttimeout: TIMEOUT,
\t}});
}}

/** The loading indicator is gone or hidden, in the top document. */
async function waitForHidden(css<<: string>>) {{
\tawait browser.switchToFrame(null);
\tawait browser.waitUntil(async () => !(await $(css).isDisplayed()), {{ timeout: TIMEOUT }});
}}
"""

_JS_EXTRA = {
    "drag-html5": f"const DRAG_HTML5 = {literal(DRAG_HTML5)};",
    "scroll-element": f"const SCROLL_ELEMENT = {literal(SCROLL_ELEMENT)};",
    "values": f"const SELECT_VALUES = {literal(SELECT_VALUES)};",
    "scroll-window": f"""
async function scrollWindow(x<<: number>>, y<<: number>>) {{
\tawait browser.switchToFrame(null);
\tawait browser.execute({literal(SCROLL_WINDOW)}, x, y);
}}""",
    "dialog": """
/** Answers the dialog the last action opened, as it was answered when recorded. */
async function answerDialog(accept<<: boolean>>, text<<?: string>>) {
\tawait browser.waitUntil(() => browser.isAlertOpen(), { timeout: TIMEOUT });
\tif (text !== undefined) await browser.sendAlertText(text);
\tif (accept) await browser.acceptAlert();
\telse await browser.dismissAlert();
}""",
}

_JS_SECRET = """
// Secrets are read from the environment: {names}.
function secret(name<<: string>>)<<: string>> {{
\tconst value = process.env[name];
\tif (!value) throw new Error("Set " + name + " to run this test");
\treturn value;
}}
"""


def js_data(key: str) -> str:
    """A typed value read from the test's data, in JavaScript or TypeScript."""
    return f"TEST_DATA[{literal(key)}]"


def wdio_code(
    name: str, steps: list[RecordedStep], env: list[str], data: TestData, ts: bool
) -> tuple[str, int]:
    """WebdriverIO with Mocha, in JavaScript or (``ts``) TypeScript."""
    body, skipped = walk(steps, WDIO)
    lines = [
        *(['import { readFileSync } from "node:fs";'] if data else []),
        'import { $, $$, browser, expect } from "@wdio/globals";',
        "",
        *_JS_HELPERS.splitlines(),
        *extras(_JS_EXTRA, uses(steps)),
    ]
    if data:
        lines += [
            "",
            f"// The values typed while recording, from {file_name(name)} next to this file.",
            "const TEST_DATA = JSON.parse(",
            f'\treadFileSync(new URL({literal(file_name(name))}, import.meta.url), "utf-8"),',
            ");",
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
    return typed("\n".join(lines), ts) + "\n", skipped


def webdriverio(
    name: str, steps: list[RecordedStep], env: list[str], data: TestData
) -> tuple[str, int]:
    return wdio_code(name, steps, env, data, ts=False)

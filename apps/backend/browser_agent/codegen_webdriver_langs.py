"""
More WebDriver languages: Selenium in C# (NUnit), Ruby (RSpec) and JavaScript
(``selenium-webdriver`` with Mocha), and WebdriverIO in TypeScript.

The same walk over the steps as ``codegen_webdriver`` (:func:`walk`), the
same helpers (find the element down its frames and shadow roots, wait for
the request, the page, the loading indicator; answer the dialog), spelled in
each language. Page text enters only through the language's literal
(``codegen_text``): C# regular strings, never verbatim or interpolated; Ruby
double-quoted strings with ``#`` escaped, so nothing is interpolated; the
JSON form for JavaScript.
"""

from __future__ import annotations

from .codegen_data import TestData, file_name
from .codegen_text import cs_literal, literal, pascal, ruby_literal
from .codegen_webdriver import (
    DRAG_HTML5,
    NETWORK_DONE,
    NETWORK_WATCH,
    SCROLL_ELEMENT,
    SCROLL_WINDOW,
    SELECT_VALUES,
    TIMEOUT_S,
    Dialect,
    Locator,
    extras,
    frame_hops,
    js_data,
    typed_value,
    uses,
    walk,
    wdio_code,
)
from .recording import RecordedStep

# --- Selenium, C# ------------------------------------------------------------------


def _cs_array(items: list[str]) -> str:
    return "new string[] {" + ", ".join(map(cs_literal, items)) + "}"


def _cs_locate(step: RecordedStep, loc: Locator) -> str:
    by = f"By.{'CssSelector' if loc[0] == 'css' else 'XPath'}({cs_literal(loc[1])})"
    args = [by]
    if step.frames:
        hops = ", ".join(_cs_array(hop) for hop in frame_hops(step))
        args.append(f"frames: new[] {{{hops}}}")
    if step.shadow:
        args.append(f"hosts: {_cs_array(step.shadow)}")
    if step.wait_visible:
        args.append("visible: true")
    if loc[2] is not None:
        args.append(f"nth: {loc[2]}")
    return f"Locate({', '.join(args)})"


def _cs_action(step: RecordedStep, el: str, target: str) -> str:
    value = typed_value(
        step, cs_literal, "Secret({})", lambda key: f"TestData[{cs_literal(key)}]"
    )
    if step.kind == "click":
        return f"{el}.Click();"
    if step.kind == "hover":
        return f"new Actions(driver).MoveToElement({el}).Perform();"
    if step.kind == "scroll":
        return f"Script(ScrollElement, {el}, {step.scroll_x}, {step.scroll_y});"
    if step.kind == "drag" and step.drag_mode == "html5":
        return f"Script(DragHtml5, {el}, {target});"
    if step.kind == "drag":
        return f"new Actions(driver).DragAndDrop({el}, {target}).Perform();"
    if step.kind == "select" and step.values and not step.secret_env:
        return f"Script(SelectValues, {el}, {_cs_array(step.values)});"
    if step.kind == "fill":
        return f"Fill({el}, {value});"
    if step.kind == "select":
        return f"new SelectElement({el}).SelectByValue({value});"
    if step.kind == "press":
        return f"{el}.SendKeys(Keys.{'Enter' if step.key == 'Enter' else 'Escape'});"
    return f"ExpectText({el}, {cs_literal(step.text)});"


CSHARP = Dialect(
    navigate=lambda url: f"driver.Navigate().GoToUrl({cs_literal(url)});",
    locate=_cs_locate,
    use=lambda found: found,
    action=_cs_action,
    bind=lambda found: f"var element = {found};",
    seen="var seen = NetworkSeen();",
    wait_network="WaitForNetwork(seen);",
    wait_page=lambda url: f"WaitForPage({cs_literal(url)});",
    wait_hidden=lambda css: f"WaitForHidden({cs_literal(css)});",
    skip="// step skipped: no selector Selenium can express",
    scroll_window=lambda x, y: f"ScrollWindow({x}, {y});",
    dialog=lambda accept, text: (
        f"AnswerDialog({'true' if accept else 'false'}, "
        f"{'null' if text is None else cs_literal(text)});"
    ),
    block=("{", "}"),
)

_CS_HELPERS = f"""\t\tprivate const string NetworkWatch = {cs_literal(NETWORK_WATCH)};
\t\tprivate const string NetworkDone = {cs_literal(NETWORK_DONE)};

\t\tprivate IWebDriver driver = null!;
\t\tprivate WebDriverWait wait = null!;

\t\t[SetUp]
\t\tpublic void OpenBrowser()
\t\t{{
\t\t\tdriver = new ChromeDriver();
\t\t\twait = new WebDriverWait(driver, TimeSpan.FromSeconds({TIMEOUT_S}));
\t\t\twait.IgnoreExceptionTypes(typeof(NoSuchElementException), typeof(StaleElementReferenceException));
\t\t}}

\t\t[TearDown]
\t\tpublic void CloseBrowser()
\t\t{{
\t\t\tdriver.Quit();
\t\t\tdriver.Dispose();
\t\t}}

\t\t/// <summary>
\t\t/// The element (the nth match), once it is there: down its frames, each in the
\t\t/// shadow roots it sits in, then its own shadow roots.
\t\t/// </summary>
\t\tprivate IWebElement Locate(By by, string[][]? frames = null, string[]? hosts = null, bool visible = false, int nth = 0)
\t\t{{
\t\t\tdriver.SwitchTo().DefaultContent();
\t\t\tforeach (var hops in frames ?? Array.Empty<string[]>())
\t\t\t{{
\t\t\t\tvar scope = ShadowScope(hops[..^1]);
\t\t\t\tdriver.SwitchTo().Frame(wait.Until(_ => Match(scope, By.CssSelector(hops[^1]), 0)));
\t\t\t}}
\t\t\tvar root = ShadowScope(hosts ?? Array.Empty<string>());
\t\t\treturn wait.Until(_ =>
\t\t\t{{
\t\t\t\tvar element = Match(root, by, nth);
\t\t\t\treturn element != null && (!visible || element.Displayed) ? element : null;
\t\t\t}})!;
\t\t}}

\t\tprivate static IWebElement? Match(ISearchContext scope, By by, int index)
\t\t{{
\t\t\tvar matches = scope.FindElements(by);
\t\t\treturn matches.Count > index ? matches[index] : null;
\t\t}}

\t\tprivate ISearchContext ShadowScope(string[] hosts)
\t\t{{
\t\t\tISearchContext scope = driver;
\t\t\tforeach (var host in hosts)
\t\t\t{{
\t\t\t\tvar current = scope;
\t\t\t\tscope = wait.Until(_ => Match(current, By.CssSelector(host), 0))!.GetShadowRoot();
\t\t\t}}
\t\t\treturn scope;
\t\t}}

\t\tprivate object Script(string code, params object[] args) =>
\t\t\t((IJavaScriptExecutor)driver).ExecuteScript(code, args);

\t\tprivate static void Fill(IWebElement element, string value)
\t\t{{
\t\t\telement.Clear();
\t\t\telement.SendKeys(value);
\t\t}}

\t\tprivate void ExpectText(IWebElement element, string text) =>
\t\t\twait.Until(_ => element.Text.Contains(text));

\t\tprivate long NetworkSeen() => Convert.ToInt64(Script(NetworkWatch));

\t\tprivate void WaitForNetwork(long seen) =>
\t\t\twait.Until(_ => Script(NetworkDone, seen) is true);

\t\tprivate void WaitForPage(string url) =>
\t\t\twait.Until(d => d.Url.Split('?', '#')[0] == url);

\t\t/// <summary>The loading indicator is gone or hidden, in the top document.</summary>
\t\tprivate void WaitForHidden(string css)
\t\t{{
\t\t\tdriver.SwitchTo().DefaultContent();
\t\t\twait.Until(d =>
\t\t\t{{
\t\t\t\tvar matches = d.FindElements(By.CssSelector(css));
\t\t\t\treturn matches.Count == 0 || !matches[0].Displayed;
\t\t\t}});
\t\t}}
"""

_CS_EXTRA = {
    "drag-html5": f"\n\t\tprivate const string DragHtml5 = {cs_literal(DRAG_HTML5)};",
    "scroll-element": f"\n\t\tprivate const string ScrollElement = {cs_literal(SCROLL_ELEMENT)};",
    "values": f"\n\t\tprivate const string SelectValues = {cs_literal(SELECT_VALUES)};",
    "scroll-window": f"""
\t\tprivate void ScrollWindow(long x, long y)
\t\t{{
\t\t\tdriver.SwitchTo().DefaultContent();
\t\t\tScript({cs_literal(SCROLL_WINDOW)}, x, y);
\t\t}}""",
    "dialog": """
\t\t/// <summary>Answers the dialog the last action opened, as it was answered when recorded.</summary>
\t\tprivate void AnswerDialog(bool accept, string? text)
\t\t{
\t\t\tvar alert = wait.Until(d =>
\t\t\t{
\t\t\t\ttry
\t\t\t\t{
\t\t\t\t\treturn d.SwitchTo().Alert();
\t\t\t\t}
\t\t\t\tcatch (NoAlertPresentException)
\t\t\t\t{
\t\t\t\t\treturn null;
\t\t\t\t}
\t\t\t})!;
\t\t\tif (text != null) alert.SendKeys(text);
\t\t\tif (accept) alert.Accept();
\t\t\telse alert.Dismiss();
\t\t}""",
}

_CS_SECRET = """
\t\t// Secrets are read from the environment: {names}.
\t\tprivate static string Secret(string name) =>
\t\t\tEnvironment.GetEnvironmentVariable(name) is {{ Length: > 0 }} value
\t\t\t\t? value
\t\t\t\t: throw new InvalidOperationException("Set " + name + " to run this test");
"""


def _cs_data(name: str, data: TestData) -> list[str]:
    """How a C# test reads its data: a JSON file next to its source, by key."""
    if not data:
        return []
    return [
        "",
        "\t\t/// <summary>The values typed while recording and the secrets' variables, from "
        f"{file_name(name)} next to this file.</summary>",
        "\t\tprivate static readonly Dictionary<string, string> TestData = "
        f"ReadTestData({cs_literal(file_name(name))});",
        "",
        "\t\t/// <summary>The file next to this source file, else copied to the build output.</summary>",
        "\t\tprivate static Dictionary<string, string> ReadTestData(string file, "
        '[CallerFilePath] string source = "")',
        "\t\t{",
        '\t\t\tvar path = Path.Combine(Path.GetDirectoryName(source) ?? "", file);',
        "\t\t\tif (!File.Exists(path)) path = Path.Combine(AppContext.BaseDirectory, file);",
        "\t\t\treturn JsonSerializer.Deserialize<Dictionary<string, string>>(File.ReadAllText(path))",
        '\t\t\t\t?? throw new InvalidOperationException(file + " holds no test data");',
        "\t\t}",
    ]


def selenium_csharp(
    name: str, steps: list[RecordedStep], env: list[str], data: TestData
) -> tuple[str, int]:
    body, skipped = walk(steps, CSHARP)
    needs = uses(steps)
    lines = [
        "using System;",
        *(
            [
                "using System.Collections.Generic;",
                "using System.IO;",
                "using System.Runtime.CompilerServices;",
                "using System.Text.Json;",
            ]
            if data
            else []
        ),
        "using NUnit.Framework;",
        "using OpenQA.Selenium;",
        "using OpenQA.Selenium.Chrome;",
        *(
            ["using OpenQA.Selenium.Interactions;"]
            if needs & {"hover", "drag-pointer"}
            else []
        ),
        "using OpenQA.Selenium.Support.UI;",
        "",
        "namespace E2E",
        "{",
        "\t/// <summary>Recorded with the WorkPilot Browser Agent.</summary>",
        "\t[TestFixture]",
        f"\tpublic class {pascal(name)}Tests",
        "\t{",
        *_CS_HELPERS.splitlines(),
        *extras(_CS_EXTRA, needs),
        *_cs_data(name, data),
    ]
    if env:
        lines += _CS_SECRET.format(names=", ".join(env)).splitlines()
    lines += [
        "",
        f"\t\t[Test(Description = {cs_literal(name)})]",
        "\t\tpublic void ReplaysTheRecordedSteps()",
        "\t\t{",
        *(f"\t\t\t{line}" for line in body),
        "\t\t}",
        "\t}",
        "}",
    ]
    return "\n".join(lines) + "\n", skipped


# --- Selenium, Ruby ----------------------------------------------------------------


def _rb_list(items: list[str]) -> str:
    return "[" + ", ".join(map(ruby_literal, items)) + "]"


def _rb_locate(step: RecordedStep, loc: Locator) -> str:
    args = [f":{loc[0]}", ruby_literal(loc[1])]
    if step.frame_shadow:
        args.append("frames: [" + ", ".join(map(_rb_list, frame_hops(step))) + "]")
    elif step.frames:
        args.append(f"frames: {_rb_list(step.frames)}")
    if step.shadow:
        args.append(f"hosts: {_rb_list(step.shadow)}")
    if step.wait_visible:
        args.append("visible: true")
    if loc[2] is not None:
        args.append(f"nth: {loc[2]}")
    return f"locate({', '.join(args)})"


def _rb_action(step: RecordedStep, el: str, target: str) -> str:
    value = typed_value(
        step,
        ruby_literal,
        "ENV.fetch({})",
        lambda key: f"test_data.fetch({ruby_literal(key)})",
    )
    if step.kind == "click":
        return f"{el}.click"
    if step.kind == "hover":
        return f"@driver.action.move_to({el}).perform"
    if step.kind == "scroll":
        return (
            f"@driver.execute_script(SCROLL_ELEMENT, {el}, "
            f"{step.scroll_x}, {step.scroll_y})"
        )
    if step.kind == "drag" and step.drag_mode == "html5":
        return f"@driver.execute_script(DRAG_HTML5, {el}, {target})"
    if step.kind == "drag":
        return f"@driver.action.drag_and_drop({el}, {target}).perform"
    if step.kind == "select" and step.values and not step.secret_env:
        return f"@driver.execute_script(SELECT_VALUES, {el}, {_rb_list(step.values)})"
    if step.kind == "fill":
        return f"fill({el}, {value})"
    if step.kind == "select":
        return (
            f"Selenium::WebDriver::Support::Select.new({el}).select_by(:value, {value})"
        )
    if step.kind == "press":
        return f"{el}.send_keys(:{'enter' if step.key == 'Enter' else 'escape'})"
    return f"expect_text({el}, {ruby_literal(step.text)})"


RUBY = Dialect(
    navigate=lambda url: f"@driver.navigate.to({ruby_literal(url)})",
    locate=_rb_locate,
    use=lambda found: found,
    action=_rb_action,
    bind=lambda found: f"element = {found}",
    seen="seen = network_seen",
    wait_network="wait_for_network(seen)",
    wait_page=lambda url: f"wait_for_page({ruby_literal(url)})",
    wait_hidden=lambda css: f"wait_for_hidden({ruby_literal(css)})",
    skip="# step skipped: no selector Selenium can express",
    scroll_window=lambda x, y: f"scroll_window({x}, {y})",
    dialog=lambda accept, text: (
        f"answer_dialog({'true' if accept else 'false'}"
        + ("" if text is None else f", {ruby_literal(text)}")
        + ")"
    ),
)

_RB_HELPERS = f"""NETWORK_WATCH = {ruby_literal(NETWORK_WATCH)}
NETWORK_DONE = {ruby_literal(NETWORK_DONE)}
"""

_RB_METHODS = f"""  let(:wait) do
    Selenium::WebDriver::Wait.new(
      timeout: {TIMEOUT_S},
      ignore: [
        Selenium::WebDriver::Error::NoSuchElementError,
        Selenium::WebDriver::Error::StaleElementReferenceError,
        Selenium::WebDriver::Error::NoSuchAlertError
      ]
    )
  end

  before {{ @driver = Selenium::WebDriver.for(:chrome) }}
  after {{ @driver.quit }}

  # The element (the nth match), once it is there: down its frames, each in the
  # shadow roots it sits in, then its own shadow roots.
  def locate(how, what, frames: [], hosts: [], visible: false, nth: 0)
    @driver.switch_to.default_content
    frames.each do |frame|
      hops = Array(frame)
      scope = shadow_scope(hops[0...-1])
      @driver.switch_to.frame(wait.until {{ scope.find_elements(css: hops[-1]).first }})
    end
    scope = shadow_scope(hosts)
    wait.until do
      element = scope.find_elements(how => what)[nth]
      element if element && (!visible || element.displayed?)
    end
  end

  def shadow_scope(hosts)
    hosts.reduce(@driver) do |scope, host|
      wait.until {{ scope.find_elements(css: host).first }}.shadow_root
    end
  end

  def fill(element, value)
    element.clear
    element.send_keys(value)
  end

  def expect_text(element, text)
    wait.until {{ element.text.include?(text) }}
  end

  def network_seen
    @driver.execute_script(NETWORK_WATCH)
  end

  def wait_for_network(seen)
    wait.until {{ @driver.execute_script(NETWORK_DONE, seen) }}
  end

  def wait_for_page(url)
    wait.until {{ @driver.current_url.split(/[?#]/).first == url }}
  end

  # The loading indicator is gone or hidden, in the top document.
  def wait_for_hidden(css)
    @driver.switch_to.default_content
    wait.until do
      element = @driver.find_elements(css: css).first
      element.nil? || !element.displayed?
    end
  end
"""

_RB_EXTRA_CONSTANTS = {
    "drag-html5": f"DRAG_HTML5 = {ruby_literal(DRAG_HTML5)}",
    "scroll-element": f"SCROLL_ELEMENT = {ruby_literal(SCROLL_ELEMENT)}",
    "values": f"SELECT_VALUES = {ruby_literal(SELECT_VALUES)}",
}

_RB_EXTRA = {
    "scroll-window": f"""
  def scroll_window(x, y)
    @driver.switch_to.default_content
    @driver.execute_script({ruby_literal(SCROLL_WINDOW)}, x, y)
  end""",
    "dialog": """
  # Answers the dialog the last action opened, as it was answered when recorded.
  def answer_dialog(accept, text = nil)
    alert = wait.until { @driver.switch_to.alert }
    alert.send_keys(text) unless text.nil?
    accept ? alert.accept : alert.dismiss
  end""",
}


def _rb_data(name: str, data: TestData) -> list[str]:
    """The ``let`` a Ruby test reads its typed values from (one per example group)."""
    if not data:
        return []
    return [
        "",
        f"  # The values typed while recording, from {file_name(name)} next to this file.",
        "  let(:test_data) do",
        f'    JSON.parse(File.read(File.join(__dir__, {ruby_literal(file_name(name))}), encoding: "utf-8"))',
        "  end",
    ]


def selenium_ruby(
    name: str, steps: list[RecordedStep], env: list[str], data: TestData
) -> tuple[str, int]:
    body, skipped = walk(steps, RUBY)
    needs = uses(steps)
    lines = [
        "# frozen_string_literal: true",
        "",
        *(['require "json"'] if data else []),
        'require "selenium-webdriver"',
        "",
        *_RB_HELPERS.splitlines(),
        *extras(_RB_EXTRA_CONSTANTS, needs),
        "",
    ]
    if env:
        lines += ["# Secrets are read from the environment: " + ", ".join(env) + "."]
    lines += [
        "# Recorded with the WorkPilot Browser Agent.",
        f"RSpec.describe {ruby_literal(name)} do",
        *_RB_METHODS.splitlines(),
        *extras(_RB_EXTRA, needs),
        *_rb_data(name, data),
        "",
        f"  it {ruby_literal('replays the recorded steps')} do",
        *(f"    {line}" for line in body),
        "  end",
        "end",
    ]
    return "\n".join(lines) + "\n", skipped


# --- Selenium, JavaScript --------------------------------------------------------


def _sjs_locate(step: RecordedStep, loc: Locator) -> str:
    by = f"By.{'css' if loc[0] == 'css' else 'xpath'}({literal(loc[1])})"
    options = []
    if step.frames:
        hops = ", ".join(
            "[" + ", ".join(map(literal, hop)) + "]" for hop in frame_hops(step)
        )
        options.append(f"frames: [{hops}]")
    if step.shadow:
        options.append("hosts: [" + ", ".join(map(literal, step.shadow)) + "]")
    if step.wait_visible:
        options.append("visible: true")
    if loc[2] is not None:
        options.append(f"nth: {loc[2]}")
    extra = f", {{ {', '.join(options)} }}" if options else ""
    return f"locate({by}{extra})"


def _sjs_action(step: RecordedStep, el: str, target: str) -> str:
    value = typed_value(step, literal, "secret({})", js_data)
    if step.kind == "click":
        return f"await {el}.click();"
    if step.kind == "hover":
        return f"await driver.actions().move({{ origin: {el} }}).perform();"
    if step.kind == "scroll":
        return (
            f"await driver.executeScript(SCROLL_ELEMENT, {el}, "
            f"{step.scroll_x}, {step.scroll_y});"
        )
    if step.kind == "drag" and step.drag_mode == "html5":
        return f"await driver.executeScript(DRAG_HTML5, {el}, {target});"
    if step.kind == "drag":
        return f"await driver.actions().dragAndDrop({el}, {target}).perform();"
    if step.kind == "select" and step.values and not step.secret_env:
        values = "[" + ", ".join(map(literal, step.values)) + "]"
        return f"await driver.executeScript(SELECT_VALUES, {el}, {values});"
    if step.kind == "fill":
        return f"await fill({el}, {value});"
    if step.kind == "select":
        return f"await new Select({el}).selectByValue({value});"
    if step.kind == "press":
        return (
            f"await {el}.sendKeys(Key.{'ENTER' if step.key == 'Enter' else 'ESCAPE'});"
        )
    return f"await expectText({el}, {literal(step.text)});"


SELENIUM_JS = Dialect(
    navigate=lambda url: f"await driver.get({literal(url)});",
    locate=_sjs_locate,
    use=lambda found: f"(await {found})",
    action=_sjs_action,
    bind=lambda found: f"const element = await {found};",
    seen="const seen = await networkSeen();",
    wait_network="await waitForNetwork(seen);",
    wait_page=lambda url: f"await waitForPage({literal(url)});",
    wait_hidden=lambda css: f"await waitForHidden({literal(css)});",
    skip="// step skipped: no selector Selenium can express",
    scroll_window=lambda x, y: f"await scrollWindow({x}, {y});",
    dialog=lambda accept, text: (
        f"await answerDialog({'true' if accept else 'false'}"
        + ("" if text is None else f", {literal(text)}")
        + ");"
    ),
    block=("{", "}"),
)

_SJS_HELPERS = f"""const TIMEOUT = {TIMEOUT_S * 1000};
// Counts the page's fetch and XHR calls, to wait for the ones an action starts.
const NETWORK_WATCH = {literal(NETWORK_WATCH)};
const NETWORK_DONE = {literal(NETWORK_DONE)};

let driver;

/** The element by finds at index in scope, or undefined. */
async function first(scope, by, index = 0) {{
\treturn (await scope.findElements(by))[index];
}}

/** The innermost of the open shadow roots of hosts, outermost first. */
async function shadowScope(hosts) {{
\tlet scope = driver;
\tfor (const host of hosts) {{
\t\tconst current = scope;
\t\tscope = await (await driver.wait(() => first(current, By.css(host)), TIMEOUT)).getShadowRoot();
\t}}
\treturn scope;
}}

/**
 * The element (the nth match), once it is there: down its frames, each in the
 * shadow roots it sits in, then its own shadow roots.
 */
async function locate(by, {{ frames = [], hosts = [], visible = false, nth = 0 }} = {{}}) {{
\tawait driver.switchTo().defaultContent();
\tfor (const hops of frames) {{
\t\tconst scope = await shadowScope(hops.slice(0, -1));
\t\tconst frame = await driver.wait(() => first(scope, By.css(hops[hops.length - 1])), TIMEOUT);
\t\tawait driver.switchTo().frame(frame);
\t}}
\tconst scope = await shadowScope(hosts);
\treturn driver.wait(async () => {{
\t\tconst element = await first(scope, by, nth);
\t\treturn element && (!visible || (await element.isDisplayed())) ? element : null;
\t}}, TIMEOUT);
}}

async function fill(element, value) {{
\tawait element.clear();
\tawait element.sendKeys(value);
}}

async function expectText(element, text) {{
\tawait driver.wait(async () => (await element.getText()).includes(text), TIMEOUT);
}}

async function networkSeen() {{
\treturn driver.executeScript(NETWORK_WATCH);
}}

async function waitForNetwork(seen) {{
\tawait driver.wait(() => driver.executeScript(NETWORK_DONE, seen), TIMEOUT);
}}

async function waitForPage(url) {{
\tawait driver.wait(async () => (await driver.getCurrentUrl()).split(/[?#]/)[0] === url, TIMEOUT);
}}

/** The loading indicator is gone or hidden, in the top document. */
async function waitForHidden(css) {{
\tawait driver.switchTo().defaultContent();
\tawait driver.wait(async () => {{
\t\tconst element = await first(driver, By.css(css));
\t\treturn !element || !(await element.isDisplayed());
\t}}, TIMEOUT);
}}
"""

_SJS_EXTRA = {
    "drag-html5": f"const DRAG_HTML5 = {literal(DRAG_HTML5)};",
    "scroll-element": f"const SCROLL_ELEMENT = {literal(SCROLL_ELEMENT)};",
    "values": f"const SELECT_VALUES = {literal(SELECT_VALUES)};",
    "scroll-window": f"""
async function scrollWindow(x, y) {{
\tawait driver.switchTo().defaultContent();
\tawait driver.executeScript({literal(SCROLL_WINDOW)}, x, y);
}}""",
    "dialog": """
/** Answers the dialog the last action opened, as it was answered when recorded. */
async function answerDialog(accept, text) {
\tconst alert = await driver.wait(until.alertIsPresent(), TIMEOUT);
\tif (text !== undefined) await alert.sendKeys(text);
\tif (accept) await alert.accept();
\telse await alert.dismiss();
}""",
}

_SJS_SECRET = """
// Secrets are read from the environment: {names}.
function secret(name) {{
\tconst value = process.env[name];
\tif (!value) throw new Error("Set " + name + " to run this test");
\treturn value;
}}
"""


def selenium_js(
    name: str, steps: list[RecordedStep], env: list[str], data: TestData
) -> tuple[str, int]:
    body, skipped = walk(steps, SELENIUM_JS)
    needs = uses(steps)
    names = [
        "Browser",
        "Builder",
        "By",
        "Key",
        *(["until"] if "dialog" in needs else []),
    ]
    lines = [
        *(
            [
                'const { readFileSync } = require("node:fs");',
                'const { join } = require("node:path");',
            ]
            if data
            else []
        ),
        f'const {{ {", ".join(names)} }} = require("selenium-webdriver");',
        'const { Select } = require("selenium-webdriver/lib/select");',
        "",
        *_SJS_HELPERS.splitlines(),
        *extras(_SJS_EXTRA, needs),
    ]
    if data:
        lines += [
            "",
            f"// The values typed while recording, from {file_name(name)} next to this file.",
            "const TEST_DATA = JSON.parse(",
            f'\treadFileSync(join(__dirname, {literal(file_name(name))}), "utf-8"),',
            ");",
        ]
    if env:
        lines += _SJS_SECRET.format(names=", ".join(env)).splitlines()
    lines += [
        "",
        f"describe({literal(name)}, function () {{",
        "\tthis.timeout(120000);",
        "",
        "\tbeforeEach(async () => {",
        "\t\tdriver = await new Builder().forBrowser(Browser.CHROME).build();",
        "\t});",
        "",
        "\tafterEach(async () => {",
        "\t\tawait driver.quit();",
        "\t});",
        "",
        f"\tit({literal('replays the recorded steps')}, async () => {{",
        *(f"\t\t{line}" for line in body),
        "\t});",
        "});",
    ]
    return "\n".join(lines) + "\n", skipped


def webdriverio_ts(
    name: str, steps: list[RecordedStep], env: list[str], data: TestData
) -> tuple[str, int]:
    return wdio_code(name, steps, env, data, ts=True)

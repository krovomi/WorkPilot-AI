"""Java and C# tests read their data from JSON, like every other format (#387).

The Java test reads ``src/test/resources/e2e/<test>.data.json`` from its
classpath with Selenium's own JSON reader; the C# test reads the file next to
its source with ``System.Text.Json``. The generated Java source is compiled by
``javac`` when the machine has one, against stubs of the Selenium and JUnit
calls it makes (no network, no jar): the code must hold together, types and
lambdas included.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest
from browser_agent.codegen import export_recording
from browser_agent.recording import RecordedStep, Recording, RequestWait, Selector


def _recording() -> Recording:
    return Recording(
        steps=[
            RecordedStep("s1", "navigate", url="http://localhost:3000/login"),
            RecordedStep(
                "s2", "fill", [Selector("css", "#email")], value='ada "q" \\ é'
            ),
            RecordedStep("s3", "fill", [Selector("css", "#pw")], secret_env="E2E_PW"),
            RecordedStep(
                "s4", "select", [Selector("css", "#plan")], secret_env="E2E_PLAN"
            ),
            RecordedStep(
                "s5",
                "click",
                [Selector("role", "Sign in", "button")],
                wait_request=RequestWait("POST", "/api/login"),
                wait_url="http://localhost:3000/home",
            ),
            RecordedStep("s6", "hover", [Selector("css", "#menu")]),
            RecordedStep(
                "s7", "assert_text", [Selector("text", "Welcome")], text="Welcome"
            ),
        ]
    )


DATA = {"email": 'ada "q" \\ é', "pw_env": "E2E_PW", "plan_env": "E2E_PLAN"}


def test_java_reads_a_json_resource_of_its_package() -> None:
    test = export_recording(_recording(), "selenium-java", "Sign up")
    assert test.path == "src/test/java/e2e/SignUpTest.java"
    assert test.data_path == "src/test/resources/e2e/sign-up.data.json"
    assert json.loads(test.data_code or "") == DATA
    lines = test.code.splitlines()
    start = lines.index(
        "\t/** The values typed while recording and the secrets' variables, "
        "from src/test/resources/e2e/sign-up.data.json. */"
    )
    assert lines[start + 1 : start + 22] == [
        '\tprivate static final Map<String, Object> TEST_DATA = readTestData("sign-up.data.json");',
        "",
        "\tprivate static Map<String, Object> readTestData(String file) {",
        "\t\ttry (InputStream in = SignUpTest.class.getResourceAsStream(file)) {",
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
        "",
    ]
    assert '\t\tfill(locate(By.cssSelector("#email")), data("email"));' in lines
    assert '\t\tfill(locate(By.cssSelector("#pw")), secret(data("pw_env")));' in lines
    assert (
        '\t\tnew Select(locate(By.cssSelector("#plan")))'
        '.selectByValue(secret(data("plan_env")));'
    ) in lines
    assert "class TestData" not in test.code and "ada" not in test.code


def test_csharp_reads_a_json_file_next_to_its_source() -> None:
    test = export_recording(_recording(), "selenium-csharp", "Sign up")
    assert test.path == "tests/E2E/SignUpTests.cs"
    assert test.data_path == "tests/E2E/sign-up.data.json"
    assert json.loads(test.data_code or "") == DATA
    lines = test.code.splitlines()
    assert lines[:6] == [
        "using System;",
        "using System.Collections.Generic;",
        "using System.IO;",
        "using System.Runtime.CompilerServices;",
        "using System.Text.Json;",
        "using NUnit.Framework;",
    ]
    start = lines.index(
        "\t\t/// <summary>The values typed while recording and the secrets' variables, "
        "from sign-up.data.json next to this file.</summary>"
    )
    assert lines[start + 1 : start + 11] == [
        "\t\tprivate static readonly Dictionary<string, string> TestData = "
        'ReadTestData("sign-up.data.json");',
        "",
        "\t\t/// <summary>The file next to this source file, else copied to the build "
        "output.</summary>",
        "\t\tprivate static Dictionary<string, string> ReadTestData(string file, "
        '[CallerFilePath] string source = "")',
        "\t\t{",
        '\t\t\tvar path = Path.Combine(Path.GetDirectoryName(source) ?? "", file);',
        "\t\t\tif (!File.Exists(path)) path = Path.Combine(AppContext.BaseDirectory, file);",
        "\t\t\treturn JsonSerializer.Deserialize<Dictionary<string, string>>"
        "(File.ReadAllText(path))",
        '\t\t\t\t?? throw new InvalidOperationException(file + " holds no test data");',
        "\t\t}",
    ]
    body = "\n".join(lines)
    assert 'Fill(Locate(By.CssSelector("#email")), TestData["email"]);' in body
    assert 'Fill(Locate(By.CssSelector("#pw")), Secret(TestData["pw_env"]));' in body
    assert (
        'new SelectElement(Locate(By.CssSelector("#plan")))'
        '.SelectByValue(Secret(TestData["plan_env"]));'
    ) in body
    assert "ada" not in test.code and "public const string" not in test.code


def test_without_data_java_and_csharp_import_nothing_for_it() -> None:
    plain = Recording(steps=[RecordedStep("s1", "click", [Selector("css", "#go")])])
    java = export_recording(plain, "selenium-java").code
    assert "import java.io" not in java and "org.openqa.selenium.json" not in java
    assert "import java.util.Map;" not in java
    cs = export_recording(plain, "selenium-csharp").code
    assert "System.Text.Json" not in cs and "CallerFilePath" not in cs


# Stubs of the Selenium 4 and JUnit 5 API the generated test calls, with the
# real signatures (``FluentWait.until`` takes a ``Function``, ``Keys`` is a
# ``CharSequence``, ``Json.toType`` infers its result type).
_STUBS = {
    "org/junit/jupiter/api/Test.java": "public @interface Test {}",
    "org/junit/jupiter/api/BeforeEach.java": "public @interface BeforeEach {}",
    "org/junit/jupiter/api/AfterEach.java": "public @interface AfterEach {}",
    "org/junit/jupiter/api/DisplayName.java": (
        "public @interface DisplayName { String value(); }"
    ),
    "org/openqa/selenium/By.java": """public abstract class By {
    public static By cssSelector(String css) { return null; }
    public static By xpath(String xpath) { return null; }
}""",
    "org/openqa/selenium/SearchContext.java": """import java.util.List;
public interface SearchContext {
    WebElement findElement(By by);
    List<WebElement> findElements(By by);
}""",
    "org/openqa/selenium/WebElement.java": """public interface WebElement extends SearchContext {
    void click();
    void clear();
    void sendKeys(CharSequence... keys);
    String getText();
    boolean isDisplayed();
    SearchContext getShadowRoot();
}""",
    "org/openqa/selenium/WebDriver.java": """public interface WebDriver extends SearchContext {
    void get(String url);
    String getCurrentUrl();
    void quit();
    TargetLocator switchTo();
    interface TargetLocator {
        WebDriver defaultContent();
        WebDriver frame(WebElement frame);
        Alert alert();
    }
}""",
    "org/openqa/selenium/Alert.java": """public interface Alert {
    void accept();
    void dismiss();
    void sendKeys(String keys);
}""",
    "org/openqa/selenium/JavascriptExecutor.java": """public interface JavascriptExecutor {
    Object executeScript(String script, Object... args);
}""",
    "org/openqa/selenium/Keys.java": """public enum Keys implements CharSequence {
    ENTER, ESCAPE;
    public char charAt(int index) { return ' '; }
    public int length() { return 1; }
    public CharSequence subSequence(int start, int end) { return this; }
}""",
    "org/openqa/selenium/chrome/ChromeDriver.java": """import java.util.List;
import org.openqa.selenium.*;
public class ChromeDriver implements WebDriver, JavascriptExecutor {
    public void get(String url) {}
    public String getCurrentUrl() { return ""; }
    public void quit() {}
    public TargetLocator switchTo() { return null; }
    public WebElement findElement(By by) { return null; }
    public List<WebElement> findElements(By by) { return null; }
    public Object executeScript(String script, Object... args) { return null; }
}""",
    "org/openqa/selenium/interactions/Actions.java": """import org.openqa.selenium.*;
public class Actions {
    public Actions(WebDriver driver) {}
    public Actions moveToElement(WebElement target) { return this; }
    public Actions dragAndDrop(WebElement source, WebElement target) { return this; }
    public void perform() {}
}""",
    "org/openqa/selenium/json/Json.java": """import java.lang.reflect.Type;
public class Json {
    public static final Type MAP_TYPE = Object.class;
    public <T> T toType(String source, Type typeOfT) { return null; }
}""",
    "org/openqa/selenium/support/ui/ExpectedCondition.java": """import java.util.function.Function;
import org.openqa.selenium.WebDriver;
public interface ExpectedCondition<T> extends Function<WebDriver, T> {}""",
    "org/openqa/selenium/support/ui/ExpectedConditions.java": """import org.openqa.selenium.*;
public class ExpectedConditions {
    public static ExpectedCondition<Boolean> invisibilityOfElementLocated(By by) { return null; }
    public static ExpectedCondition<Alert> alertIsPresent() { return null; }
}""",
    "org/openqa/selenium/support/ui/Select.java": """import org.openqa.selenium.WebElement;
public class Select {
    public Select(WebElement element) {}
    public void selectByValue(String value) {}
}""",
    "org/openqa/selenium/support/ui/WebDriverWait.java": """import java.time.Duration;
import java.util.function.Function;
import org.openqa.selenium.WebDriver;
public class WebDriverWait {
    public WebDriverWait(WebDriver driver, Duration timeout) {}
    public <V> V until(Function<? super WebDriver, V> isTrue) { return null; }
}""",
}


def _write_stubs(root: Path) -> list[Path]:
    files = []
    for rel, body in _STUBS.items():
        file = root / rel
        file.parent.mkdir(parents=True, exist_ok=True)
        package = rel.rsplit("/", 1)[0].replace("/", ".")
        file.write_text(f"package {package};\n{body}\n", encoding="utf-8")
        files.append(file)
    return files


@pytest.mark.skipif(shutil.which("javac") is None, reason="javac is not installed")
def test_the_generated_java_test_compiles(tmp_path: Path) -> None:
    javac = shutil.which("javac")
    assert javac is not None
    test = export_recording(_recording(), "selenium-java", "Sign up")
    sources = _write_stubs(tmp_path / "src")
    generated = tmp_path / "src" / test.path.removeprefix("src/test/java/")
    generated.parent.mkdir(parents=True, exist_ok=True)
    generated.write_text(test.code, encoding="utf-8")
    result = subprocess.run(
        [
            javac,
            "--release",
            "11",
            "-encoding",
            "UTF-8",
            "-d",
            str(tmp_path / "out"),
            *map(str, sources),
            str(generated),
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=180,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert (tmp_path / "out" / "e2e" / "SignUpTest.class").is_file()

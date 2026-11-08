"""Toolbox analyses on every stack: regression tests, i18n catalogs, a11y markup."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest
from i18n_agent.catalogs import discover_catalogs
from i18n_agent.i18n_scanner import I18nScanner
from regression_guardian import (
    Incident,
    IncidentSource,
    StackFrame,
    TestFramework,
    TestGenerator,
)
from regression_guardian.stacks import detect_framework

_RUNNERS = Path(__file__).resolve().parents[1] / "apps" / "backend" / "runners"


def _write(root: Path, rel: str, text: str = "") -> None:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _runner(name: str):
    spec = importlib.util.spec_from_file_location(name, _RUNNERS / f"{name}.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _incident(file: str = "", message: str = "boom") -> Incident:
    frames = [StackFrame(file=file, function="charge_card", line=12)] if file else []
    return Incident(
        id="inc-1",
        source=IncidentSource.SENTRY,
        title="Payment failed",
        exception_type="ValueError",
        exception_message=message,
        stack_frames=frames,
    )


# --- Regression Guardian ------------------------------------------------------


@pytest.mark.parametrize(
    ("faulting", "manifest", "expected"),
    [
        ("app/billing.py", "pyproject.toml", TestFramework.PYTEST),
        ("src/Billing/Charge.cs", "Billing.csproj", TestFramework.XUNIT),
        ("src/main/java/Billing.java", "pom.xml", TestFramework.JUNIT5),
        ("app/src/main/kotlin/Billing.kt", "build.gradle.kts", TestFramework.JUNIT5),
        ("internal/billing.go", "go.mod", TestFramework.GO_TEST),
        ("src/billing.rs", "Cargo.toml", TestFramework.CARGO_TEST),
        ("app/Billing.php", "composer.json", TestFramework.PHPUNIT),
        ("app/models/billing.rb", "Gemfile", TestFramework.RSPEC),
        ("lib/billing.dart", "pubspec.yaml", TestFramework.DART_TEST),
        ("Sources/Billing.swift", "Package.swift", TestFramework.XCTEST),
    ],
)
def test_regression_tests_follow_the_faulting_stack(
    tmp_path: Path, faulting: str, manifest: str, expected: TestFramework
) -> None:
    _write(tmp_path, manifest)

    framework = detect_framework(tmp_path, faulting)
    test = TestGenerator().generate(_incident(faulting), framework)

    assert framework is expected
    assert test.framework is expected
    assert "inc-1" in test.test_code


def test_regression_framework_reads_the_project_tooling(tmp_path: Path) -> None:
    _write(tmp_path, "package.json", '{"devDependencies": {"vitest": "^3"}}')
    assert detect_framework(tmp_path, "src/cart.tsx") is TestFramework.VITEST

    _write(
        tmp_path, "Api.Tests/Api.Tests.csproj", '<PackageReference Include="NUnit" />'
    )
    assert detect_framework(tmp_path, "Api/Cart.cs") is TestFramework.NUNIT

    other = tmp_path / "go-only"
    _write(other, "go.mod", "module x\n")
    assert detect_framework(other, None) is TestFramework.GO_TEST


def test_incident_text_never_becomes_code() -> None:
    hostile = '"""\nimport payload\n*/ `rm` \' ; ?>'
    for framework in TestFramework:
        code = TestGenerator().generate(_incident("a.py", hostile), framework).test_code
        assert "\nimport payload" not in code
        plain = TestGenerator().generate(_incident("a.py"), framework).test_code
        assert code.count('"""') == plain.count('"""')
        assert code.count("*/") == plain.count("*/")
        assert "`rm`" not in code
        assert "?>" not in code


def test_regression_runner_generates_for_the_project_stack(tmp_path: Path) -> None:
    runner = _runner("regression_guardian_runner")
    _write(tmp_path, "pubspec.yaml", "name: shop\n")
    _write(
        tmp_path,
        ".workpilot/incidents/1.json",
        '{"event_id": "e1", "title": "StateError", "level": "error", "exception": '
        '{"values": [{"type": "StateError", "value": "bad state", "stacktrace": '
        '{"frames": [{"filename": "lib/cart.dart", "function": "add", "lineno": 3}]}}]}}',
    )

    results = runner.run_scan(tmp_path)["results"]

    assert results and results[0]["generatedTest"]["framework"] == "dart_test"


# --- i18n ---------------------------------------------------------------------


def test_i18n_reads_the_catalogs_of_every_stack(tmp_path: Path) -> None:
    _write(tmp_path, "web/src/i18n/locales/en/common.json", '{"save": "Save"}')
    _write(tmp_path, "web/src/i18n/locales/fr/common.json", '{"save": "Enregistrer"}')
    resx = '<root><data name="Hello"><value>{}</value></data></root>'
    _write(tmp_path, "Api/Resources/Strings.resx", resx.format("Hello"))
    _write(tmp_path, "Api/Resources/Strings.fr.resx", resx.format("Bonjour"))
    _write(tmp_path, "app/lib/l10n/app_en.arb", '{"title": "Shop", "@title": {}}')
    _write(tmp_path, "app/lib/l10n/app_fr.arb", '{"title": "Boutique"}')
    strings = '<resources><string name="cart">{}</string></resources>'
    _write(tmp_path, "android/res/values/strings.xml", strings.format("Cart"))
    _write(tmp_path, "android/res/values-fr/strings.xml", strings.format("Panier"))
    _write(tmp_path, "ios/fr.lproj/Localizable.strings", '"pay" = "Payer";\n')
    _write(tmp_path, "rails/config/locales/fr.yml", "fr:\n  hello: Bonjour\n")
    _write(tmp_path, "java/messages_fr.properties", "greeting=Bonjour\n")
    _write(
        tmp_path, "py/locale/fr/LC_MESSAGES/django.po", 'msgid "Hi"\nmsgstr "Salut"\n'
    )
    _write(tmp_path, "src/config.json", '{"not": "a catalog"}')

    catalogs = discover_catalogs(tmp_path, "en")

    assert set(catalogs) == {"en", "fr"}
    fr = catalogs["fr"]
    assert fr["common"] == {"save": "Enregistrer"}
    assert fr["Strings"] == {"Hello": "Bonjour"}
    assert fr["arb"] == {"title": "Boutique"}
    assert fr["strings"] == {"cart": "Panier"}
    assert fr["Localizable"] == {"pay": "Payer"}
    assert fr["fr"] == {"hello": "Bonjour"}
    assert fr["messages"] == {"greeting": "Bonjour"}
    assert "Hi" in fr["gettext"]
    assert catalogs["en"]["Strings"] == {"Hello": "Hello"}
    assert "@title" not in catalogs["en"]["arb"]


def test_i18n_flags_hardcoded_text_in_native_ui() -> None:
    scanner = I18nScanner()
    samples = {
        "lib/home.dart": "child: Text('Welcome back'),",
        "Views/Home.swift": 'Text("Welcome back")',
        "ui/Home.kt": 'Text(text = "Welcome back")',
        "res/layout/home.xml": '<TextView android:text="Welcome back" />',
        "Views/Main.xaml": '<Button Content="Save changes" />',
        "Pages/Index.razor": "<h1>Welcome back</h1>",
    }
    for path, line in samples.items():
        assert scanner.scan_file_for_hardcoded(path, line), path


def test_i18n_runner_scans_every_ui_source(tmp_path: Path) -> None:
    runner = _runner("i18n_runner")
    for rel in ("a.razor", "b.dart", "c.swift", "d.xaml", "e.php", "f.astro"):
        _write(tmp_path, f"ui/{rel}")
    _write(tmp_path, "node_modules/x/g.tsx")

    names = {p.name for p in runner._iter_source_files(tmp_path)}

    assert names == {"a.razor", "b.dart", "c.swift", "d.xaml", "e.php", "f.astro"}


# --- Accessibility ------------------------------------------------------------


def test_a11y_scans_server_and_component_markup(tmp_path: Path) -> None:
    runner = _runner("accessibility_runner")
    project = tmp_path / "build" / "shop"
    for rel in ("Index.razor", "home.cshtml", "page.blade.php", "a.astro", "b.erb"):
        _write(project, f"views/{rel}", "<img src='x.png'>")
    _write(project, "bin/Debug/c.cshtml")

    names = {p.name for p in runner._iter_target_files(project)}

    assert names == {"Index.razor", "home.cshtml", "page.blade.php", "a.astro", "b.erb"}


# --- Compliance ---------------------------------------------------------------


def test_compliance_reads_evidence_from_every_ci_platform(tmp_path: Path) -> None:
    runner = _runner("compliance_runner")
    for rel in ("azure-pipelines.yml", "Jenkinsfile", "renovate.json", "CODEOWNERS"):
        _write(tmp_path, rel, "x")

    sources = runner._collect_sources(tmp_path)
    found = {item["source"] for items in sources.values() for item in items}

    assert {
        "azure-pipelines.yml",
        "Jenkinsfile",
        "renovate.json",
        "CODEOWNERS",
    } <= found

"""Targeted QA beyond Python and TypeScript: every ecosystem's test convention.

A small change in a .NET, Java/Kotlin, Go, Rust, PHP, Swift, Flutter, Ruby,
Elixir or C/C++ repository used to get the full review because the mapping
only knew ``test_x.py`` and ``x.test.ts``. These tests pin, for each
ecosystem, the source → test convention its tooling creates, what is never a
test, what keeps the full review, and the run evidence the gate accepts when
the runner selects tests by class or package instead of by path.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest
from foundation.change_scope import change_scope, classify, targeted_blocker
from foundation.test_conventions import is_test_dir, run_evidence, run_examples
from foundation.touched_tests import is_mappable, is_test_file, tests_for

REPO = [
    # .NET, Blazor, WPF code-behind
    "src/Shop/Services/Cart.cs",
    "tests/Shop.Tests/Services/CartTests.cs",
    "src/Shop/Pages/Counter.razor",
    "src/Shop/Pages/Counter.razor.cs",
    "tests/Shop.UnitTests/Pages/CounterTests.razor",
    "src/Desk/MainWindow.xaml.cs",
    "src/Desk.Tests/MainWindowTest.cs",
    "src/Fn/Parser.fs",
    "src/Fn.Tests/ParserTests.fs",
    "tests/Shop.Tests/Builders/CartBuilder.cs",
    # JVM: Maven, Android, Kotlin Multiplatform, Failsafe, Spock
    "api/src/main/java/com/acme/Order.java",
    "api/src/test/java/com/acme/OrderTest.java",
    "api/src/main/java/com/acme/Repo.java",
    "api/src/test/java/com/acme/RepoIT.java",
    "app/src/main/kotlin/acme/Login.kt",
    "app/src/androidTest/kotlin/acme/LoginTest.kt",
    "shared/src/commonMain/kotlin/Clock.kt",
    "shared/src/commonTest/kotlin/ClockTests.kt",
    "svc/src/main/groovy/Mail.groovy",
    "svc/src/test/groovy/MailSpec.groovy",
    "other/src/test/java/OrderTest.java",
    # Go
    "internal/auth/token.go",
    "internal/auth/token_test.go",
    "internal/db/pool.go",
    "test/pool_test.go",
    # Rust
    "core/src/parser.rs",
    "core/tests/parser.rs",
    "core/src/lexer.rs",
    "core/src/lexer/tests.rs",
    "core/src/eval.rs",
    "core/src/eval_test.rs",
    "core/src/inline.rs",
    # PHP (Laravel, Symfony)
    "app/Http/Controllers/UserController.php",
    "tests/Feature/UserControllerTest.php",
    # Swift
    "Sources/Kit/Formatter.swift",
    "Tests/KitTests/FormatterTests.swift",
    # Dart / Flutter
    "lib/src/cart_widget.dart",
    "test/src/cart_widget_test.dart",
    "lib/checkout.dart",
    "integration_test/checkout_test.dart",
    # Ruby, Elixir, C/C++
    "app/models/invoice.rb",
    "spec/models/invoice_spec.rb",
    "lib/ledger.ex",
    "test/ledger_test.exs",
    "src/codec.cpp",
    "src/codec.h",
    "src/codec_test.cc",
    # frontend frameworks
    "web/src/components/Card.vue",
    "web/src/components/Card.spec.ts",
    "web/src/lib/Toggle.svelte",
    "web/src/lib/Toggle.test.ts",
    "ng/src/app/menu/menu.component.ts",
    "ng/src/app/menu/menu.component.html",
    "ng/src/app/menu/menu.component.scss",
    "ng/src/app/menu/menu.component.spec.ts",
    "next/app/dashboard/page.tsx",
    "next/__tests__/page.test.tsx",
    # not tests
    "latest/Release.java",
    "src/SPLIT.java",
    "src/Contest.cs",
]


@pytest.mark.parametrize(
    ("source", "tests"),
    [
        ("src/Shop/Services/Cart.cs", ("tests/Shop.Tests/Services/CartTests.cs",)),
        (
            "src/Shop/Pages/Counter.razor",
            ("tests/Shop.UnitTests/Pages/CounterTests.razor",),
        ),
        (
            "src/Shop/Pages/Counter.razor.cs",
            ("tests/Shop.UnitTests/Pages/CounterTests.razor",),
        ),
        ("src/Desk/MainWindow.xaml.cs", ("src/Desk.Tests/MainWindowTest.cs",)),
        ("src/Fn/Parser.fs", ("src/Fn.Tests/ParserTests.fs",)),
        (
            "api/src/main/java/com/acme/Order.java",
            ("api/src/test/java/com/acme/OrderTest.java",),
        ),
        (
            "api/src/main/java/com/acme/Repo.java",
            ("api/src/test/java/com/acme/RepoIT.java",),
        ),
        (
            "app/src/main/kotlin/acme/Login.kt",
            ("app/src/androidTest/kotlin/acme/LoginTest.kt",),
        ),
        (
            "shared/src/commonMain/kotlin/Clock.kt",
            ("shared/src/commonTest/kotlin/ClockTests.kt",),
        ),
        ("svc/src/main/groovy/Mail.groovy", ("svc/src/test/groovy/MailSpec.groovy",)),
        ("internal/auth/token.go", ("internal/auth/token_test.go",)),
        ("core/src/parser.rs", ("core/tests/parser.rs",)),
        ("core/src/lexer.rs", ("core/src/lexer/tests.rs",)),
        ("core/src/eval.rs", ("core/src/eval_test.rs",)),
        (
            "app/Http/Controllers/UserController.php",
            ("tests/Feature/UserControllerTest.php",),
        ),
        ("Sources/Kit/Formatter.swift", ("Tests/KitTests/FormatterTests.swift",)),
        ("lib/src/cart_widget.dart", ("test/src/cart_widget_test.dart",)),
        ("lib/checkout.dart", ("integration_test/checkout_test.dart",)),
        ("app/models/invoice.rb", ("spec/models/invoice_spec.rb",)),
        ("lib/ledger.ex", ("test/ledger_test.exs",)),
        ("src/codec.cpp", ("src/codec_test.cc",)),
        ("src/codec.h", ("src/codec_test.cc",)),
        ("web/src/components/Card.vue", ("web/src/components/Card.spec.ts",)),
        ("web/src/lib/Toggle.svelte", ("web/src/lib/Toggle.test.ts",)),
        (
            "ng/src/app/menu/menu.component.ts",
            ("ng/src/app/menu/menu.component.spec.ts",),
        ),
        (
            "ng/src/app/menu/menu.component.html",
            ("ng/src/app/menu/menu.component.spec.ts",),
        ),
        (
            "ng/src/app/menu/menu.component.scss",
            ("ng/src/app/menu/menu.component.spec.ts",),
        ),
        ("next/app/dashboard/page.tsx", ("next/__tests__/page.test.tsx",)),
        # a test maps to itself
        ("internal/auth/token_test.go", ("internal/auth/token_test.go",)),
        (
            "tests/Feature/UserControllerTest.php",
            ("tests/Feature/UserControllerTest.php",),
        ),
    ],
)
def test_each_ecosystem_maps_its_sources_to_its_tests(source, tests):
    assert tests_for(source, REPO) == tests


@pytest.mark.parametrize(
    "source",
    [
        "internal/db/pool.go",  # Go tests live in the package's own directory
        "core/src/inline.rs",  # no #[cfg(test)] seen by the caller
        "latest/Release.java",
    ],
)
def test_a_source_without_a_conventional_test_is_unmapped(source):
    assert tests_for(source, REPO) == ()


def test_a_test_of_another_module_does_not_count():
    # other/src/test/java/OrderTest.java is not under api/: never Order.java's.
    tests = tests_for("api/src/main/java/com/acme/Order.java", REPO)
    assert "other/src/test/java/OrderTest.java" not in tests


def test_a_rust_module_with_inline_tests_maps_to_itself():
    assert tests_for("core/src/inline.rs", REPO, inline=["core/src/inline.rs"]) == (
        "core/src/inline.rs",
    )


@pytest.mark.parametrize(
    ("path", "expected"),
    [
        ("tests/Shop.Tests/Services/CartTests.cs", True),
        ("tests/Shop.Tests/Builders/CartBuilder.cs", False),  # helper, not a test
        ("src/Contest.cs", False),
        ("api/src/test/java/com/acme/RepoIT.java", True),
        ("src/SPLIT.java", False),
        ("internal/auth/token_test.go", True),
        ("internal/auth/token.go", False),
        ("core/tests/parser.rs", True),
        ("core/src/lexer/tests.rs", True),
        ("core/src/parser.rs", False),
        ("spec/models/invoice_spec.rb", True),
        ("test/ledger_test.exs", True),
        ("lib/ledger.ex", False),
        ("ng/src/app/menu/menu.component.html", False),
    ],
)
def test_test_files_are_recognised_by_their_ecosystem(path, expected):
    assert is_test_file(path) is expected


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("tests", True),
        ("spec", True),
        ("Shop.Tests", True),
        ("Shop.UnitTests", True),
        ("KitTests", True),
        ("androidTest", True),
        ("commonTest", True),
        ("integration_test", True),
        ("latest", False),
        ("contest", False),
        ("src", False),
    ],
)
def test_test_directories(name, expected):
    assert is_test_dir(name) is expected


@pytest.mark.parametrize(
    "path",
    [
        "src/Shop/Program.cs",
        "src/Shop/Startup.cs",
        "src/Shop/_Imports.razor",
        "core/build.rs",
        "Package.swift",
        "mix.exs",
        "spec/spec_helper.rb",
        "src/Shop/Forms/Main.Designer.cs",
        "obj/Shop.g.cs",
        "api/proto/order.pb.go",
        "lib/models/user.g.dart",
        "lib/models/user.freezed.dart",
    ],
)
def test_project_wide_and_generated_files_keep_the_full_review(path):
    assert targeted_blocker(path)


@pytest.mark.parametrize(
    ("path", "expected"),
    [
        ("ng/src/app/menu/menu.component.html", True),
        ("web/src/index.html", False),
        ("web/src/theme.scss", False),
        ("src/Shop/Pages/Counter.razor", True),
        ("api/pom.xml", False),
        ("Shop.csproj", False),
    ],
)
def test_what_the_targeted_tier_maps(path, expected):
    assert is_mappable(path) is expected


def test_a_small_dotnet_change_is_targeted():
    scope = classify(
        ["src/Shop/Services/Cart.cs", "tests/Shop.Tests/Services/CartTests.cs"],
        20,
        repo_files=REPO,
    )
    assert scope.is_targeted, scope.reason
    assert scope.tests == ("tests/Shop.Tests/Services/CartTests.cs",)


def test_a_dotnet_helper_without_a_test_keeps_the_full_review():
    scope = classify(["tests/Shop.Tests/Builders/CartBuilder.cs"], 5, repo_files=REPO)
    assert scope.is_full
    assert "no test found" in scope.reason


# --- the gate's run evidence -------------------------------------------------


@pytest.mark.parametrize(
    ("test", "command", "expected"),
    [
        (
            "tests/Shop.Tests/Services/CartTests.cs",
            'dotnet test --filter "FullyQualifiedName~CartTests"',
            True,
        ),
        (
            "tests/Shop.Tests/Services/CartTests.cs",
            "dotnet test tests/Shop.Tests",
            True,
        ),
        (
            "tests/Shop.Tests/Services/CartTests.cs",
            'dotnet test --filter "FullyQualifiedName~CartTestsLegacy"',
            False,
        ),
        (
            "api/src/test/java/com/acme/OrderTest.java",
            "mvn -Dtest=OrderTest test",
            True,
        ),
        (
            "api/src/test/java/com/acme/OrderTest.java",
            "./gradlew test --tests 'com.acme.OrderTest'",
            True,
        ),
        (
            "api/src/test/java/com/acme/OrderTest.java",
            "mvn -Dtest=OrderTests test",
            False,
        ),
        ("internal/auth/token_test.go", "go test ./internal/auth -cover", True),
        ("internal/auth/token_test.go", "go test ./internal/auth/... -cover", True),
        ("internal/auth/token_test.go", "go test ./internal/authz", False),
        ("core/tests/parser.rs", "cargo test --test parser", True),
        ("core/src/inline.rs", "cargo llvm-cov -- inline::", True),
        (
            "Tests/KitTests/FormatterTests.swift",
            "swift test --filter FormatterTests",
            True,
        ),
        ("spec/models/invoice_spec.rb", "bundle exec rspec spec/models", True),
    ],
)
def test_the_run_evidence_of_class_and_package_runners(test, command, expected):
    assert bool(run_evidence(test).search(command)) is expected


def test_the_gate_accepts_a_dotnet_filter_run():
    from qa.targeted_gate import evaluate_targeted

    scope = classify(["src/Shop/Services/Cart.cs"], 10, repo_files=REPO)
    test = "tests/Shop.Tests/Services/CartTests.cs"
    signoff = {
        "status": "approved",
        "targeted_tests": [{"file": test, "passed": True}],
        "coverage": {"measured": True, "touched_files": 100},
    }
    ran = ['dotnet test --filter "FullyQualifiedName~CartTests" --collect:"XPlat"']
    assert evaluate_targeted(signoff, scope, ran, 100) == []
    assert evaluate_targeted(signoff, scope, ["dotnet build"], 100)


def test_python_and_script_tests_still_need_their_path_or_name():
    from qa.targeted_gate import _was_run

    assert not _was_run("tests/test_calc.py", ["pytest -k test_calc"])
    assert _was_run("tests/test_calc.py", ["pytest tests/test_calc.py"])


def test_the_run_examples_cover_only_the_ecosystems_present():
    examples = "\n".join(
        run_examples(
            [
                "tests/Shop.Tests/Services/CartTests.cs",
                "internal/auth/token_test.go",
            ]
        )
    )
    assert "FullyQualifiedName~CartTests" in examples
    assert "go test ./internal/auth" in examples
    assert "cargo" not in examples
    assert "mvn" not in examples


# --- from git and the disk -------------------------------------------------------


def _git(cwd: Path, *args: str) -> None:
    subprocess.run(
        ["git", "-c", "user.email=qa@test", "-c", "user.name=qa", *args],
        cwd=cwd,
        check=True,
        capture_output=True,
    )


@pytest.fixture
def rust_repo(tmp_path: Path) -> Path:
    _git(tmp_path, "init", "-q", "-b", "main")
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "calc.rs").write_text(
        "pub fn add(a: i32, b: i32) -> i32 { a + b }\n\n"
        "#[cfg(test)]\nmod tests {\n    #[test]\n    fn adds() { assert_eq!(super::add(1, 2), 3); }\n}\n",
        encoding="utf-8",
    )
    (tmp_path / "src" / "plain.rs").write_text(
        "pub fn id(a: i32) -> i32 { a }\n", encoding="utf-8"
    )
    _git(tmp_path, "add", ".")
    _git(tmp_path, "commit", "-q", "-m", "init")
    _git(tmp_path, "checkout", "-q", "-b", "task")
    return tmp_path


def test_a_rust_change_with_its_own_tests_is_targeted(rust_repo):
    calc = rust_repo / "src" / "calc.rs"
    calc.write_text(
        calc.read_text(encoding="utf-8").replace("a + b", "b + a"), encoding="utf-8"
    )
    _git(rust_repo, "commit", "-qam", "swap")

    scope = change_scope(rust_repo, "main")

    assert scope.is_targeted, scope.reason
    assert scope.test_map == (("src/calc.rs", ("src/calc.rs",)),)


def test_a_rust_change_without_tests_keeps_the_full_review(rust_repo):
    plain = rust_repo / "src" / "plain.rs"
    plain.write_text("pub fn id(a: i32) -> i32 { a + 0 }\n", encoding="utf-8")
    _git(rust_repo, "commit", "-qam", "touch")

    scope = change_scope(rust_repo, "main")

    assert scope.is_full
    assert "no test found for src/plain.rs" in scope.reason


def test_the_targeted_prompt_gives_the_ecosystem_commands(rust_repo):
    from prompts_pkg import get_qa_reviewer_targeted_prompt

    calc = rust_repo / "src" / "calc.rs"
    calc.write_text(
        calc.read_text(encoding="utf-8").replace("a + b", "b + a"), encoding="utf-8"
    )
    _git(rust_repo, "commit", "-qam", "swap")
    spec_dir = rust_repo / ".workpilot" / "specs" / "001"
    spec_dir.mkdir(parents=True)
    (spec_dir / "spec.md").write_text("# Swap\n", encoding="utf-8")
    (spec_dir / "implementation_plan.json").write_text("{}", encoding="utf-8")

    prompt = get_qa_reviewer_targeted_prompt(
        spec_dir, rust_repo, change_scope(rust_repo, "main")
    )

    assert "cargo llvm-cov --summary-only -- calc" in prompt
    assert "#[cfg(test)]" in prompt
    assert "pytest" not in prompt.split("THE TESTS TO RUN")[1].split("WHAT ELSE")[0]
    assert "{{" not in prompt

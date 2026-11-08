"""Blast radius on every stack: imports, includes, and type references."""

from __future__ import annotations

from pathlib import Path

from analysis.blast_radius import _is_test_file, analyze_blast_radius


def _write(root: Path, rel: str, text: str) -> None:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _sources(report) -> set[str]:
    return {edge.source for edge in report.dependents}


def test_csharp_dependents_are_found_by_type_name(tmp_path: Path) -> None:
    _write(
        tmp_path,
        "src/Acme.Orders/Services/OrderService.cs",
        "namespace Acme.Orders.Services;\npublic sealed class OrderService { }\n",
    )
    _write(
        tmp_path,
        "src/Acme.Api/Controllers/OrdersController.cs",
        "using Acme.Orders.Services;\npublic class OrdersController(OrderService orders) { }\n",
    )
    _write(
        tmp_path,
        "tests/Acme.Orders.Tests/OrderServiceTests.cs",
        "public class OrderServiceTests { private readonly OrderService _sut = new(); }\n",
    )
    _write(tmp_path, "src/Acme.Api/Program.cs", "var app = WebApplication.Create();\n")

    report = analyze_blast_radius(
        tmp_path, ["src/Acme.Orders/Services/OrderService.cs"]
    )

    assert _sources(report) == {
        "src/Acme.Api/Controllers/OrdersController.cs",
        "tests/Acme.Orders.Tests/OrderServiceTests.cs",
    }
    assert report.tests == ["tests/Acme.Orders.Tests/OrderServiceTests.cs"]


def test_php_use_and_c_include_are_imports(tmp_path: Path) -> None:
    _write(
        tmp_path,
        "app/Services/Billing.php",
        "<?php\nnamespace App\\Services;\nclass Billing {}\n",
    )
    _write(
        tmp_path,
        "app/Http/InvoiceController.php",
        "<?php\nuse App\\Services\\Billing;\n",
    )
    _write(tmp_path, "src/hash.h", "int hash(const char *s);\n")
    _write(tmp_path, "src/main.c", '#include "hash.h"\nint main(void) { return 0; }\n')

    php = analyze_blast_radius(tmp_path, ["app/Services/Billing.php"])
    c = analyze_blast_radius(tmp_path, ["src/hash.h"])

    assert _sources(php) == {"app/Http/InvoiceController.php"}
    assert _sources(c) == {"src/main.c"}


def test_kotlin_and_swift_types_without_imports(tmp_path: Path) -> None:
    _write(
        tmp_path,
        "app/src/main/kotlin/Cart.kt",
        "data class Cart(val items: List<String>)\n",
    )
    _write(tmp_path, "app/src/main/kotlin/Checkout.kt", "fun pay(cart: Cart) = Unit\n")
    _write(
        tmp_path, "Sources/App/Session.swift", "struct Session { let token: String }\n"
    )
    _write(
        tmp_path, "Tests/AppTests/SessionSpec.swift", 'let s = Session(token: "x")\n'
    )

    kotlin = analyze_blast_radius(tmp_path, ["app/src/main/kotlin/Cart.kt"])
    swift = analyze_blast_radius(tmp_path, ["Sources/App/Session.swift"])

    assert _sources(kotlin) == {"app/src/main/kotlin/Checkout.kt"}
    assert swift.tests == ["Tests/AppTests/SessionSpec.swift"]


def test_test_files_are_recognised_in_every_stack() -> None:
    for path in (
        "tests/test_api.py",
        "pkg/hash_test.go",
        "src/cart.test.ts",
        "src/cart.spec.js",
        "src/Acme.Tests/OrderServiceTests.cs",
        "src/test/java/acme/CartTest.java",
        "Tests/AppTests/SessionSpec.swift",
        "spec/models/user_spec.rb",
    ):
        assert _is_test_file(path), path
    for path in ("src/latest.ts", "src/Contest.cs", "src/attestation.py"):
        assert not _is_test_file(path), path


def test_paths_that_are_not_files_analyse_nothing(tmp_path: Path) -> None:
    report = analyze_blast_radius(tmp_path, ["src/missing.cs"])

    assert report.targets == []
    assert report.dependents == []

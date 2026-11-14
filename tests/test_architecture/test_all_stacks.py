"""Architecture checks on every stack: imports read, layers inferred, violations found.

Each case builds a small Clean Architecture project in the stack's own layout,
plants one import from the domain (or application) into an outer layer, and
expects the inferred rules to report exactly that import and nothing else.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "apps" / "backend"))

from architecture.clean_layers import infer_clean_layers
from architecture.config import infer_architecture_config
from architecture.lang_imports import (
    parse_csharp,
    parse_dart,
    parse_go,
    parse_jvm,
    parse_msbuild_references,
    parse_php,
    parse_rust,
    parse_swift,
)
from architecture.rules_engine import ArchitectureRulesEngine


def _write(root: Path, rel: str, content: str = "") -> None:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def _layer_findings(project: Path) -> list[tuple[str, str]]:
    config = infer_architecture_config(project, {})
    report = ArchitectureRulesEngine(project, config).validate()
    return sorted(
        (v.file, v.import_target)
        for v in report.violations + report.warnings
        if v.type == "layer_violation"
    )


# ---------------------------------------------------------------------------
# Readers
# ---------------------------------------------------------------------------


class TestReaders:
    def test_csharp_using_forms(self):
        found = parse_csharp(
            "using System;\n"
            "global using Shop.Domain.Users;\n"
            "using static Shop.Application.Guards;\n"
            "using Db = Shop.Infrastructure.Persistence;\n"
            "namespace Shop.Api;\n"
            "using (var scope = x) { }\n"
        )
        assert [t for t, _, _ in found] == [
            "System",
            "Shop.Domain.Users",
            "Shop.Application.Guards",
            "Shop.Infrastructure.Persistence",
        ]
        assert found[1][1] == 2

    def test_msbuild_project_references(self):
        found = parse_msbuild_references(
            "<ItemGroup>\n"
            '  <ProjectReference Include="..\\Shop.Domain\\Shop.Domain.csproj" />\n'
            '  <ProjectReference Include="../Shop.Infrastructure/Shop.Infrastructure.csproj"/>\n'
            '  <PackageReference Include="Dapper" Version="2.1.0" />\n'
            "</ItemGroup>\n"
        )
        assert [t for t, _, _ in found] == ["Shop.Domain", "Shop.Infrastructure"]

    def test_jvm_imports(self):
        found = parse_jvm(
            "package com.acme.shop.domain;\n"
            "import java.util.List;\n"
            "import static org.junit.Assert.assertTrue;\n"
            "import com.acme.shop.infrastructure.*;\n"
            "import com.acme.shop.application.OrderService\n"
        )
        assert [t for t, _, _ in found] == [
            "java.util.List",
            "org.junit.Assert.assertTrue",
            "com.acme.shop.infrastructure",
            "com.acme.shop.application.OrderService",
        ]

    def test_go_single_and_block_imports(self):
        found = parse_go(
            'package domain\n\nimport "fmt"\n\nimport (\n\t"strings"\n'
            '\tdb "github.com/acme/shop/internal/infrastructure"\n)\n'
        )
        assert [t for t, _, _ in found] == [
            "fmt",
            "strings",
            "github.com/acme/shop/internal/infrastructure",
        ]

    def test_php_use_forms(self):
        found = parse_php(
            "<?php\nnamespace App\\Domain;\n"
            "use App\\Infrastructure\\Doctrine\\UserRepository;\n"
            "use function App\\Support\\helper;\n"
            "use App\\Application\\{CreateUser, DeleteUser};\n"
        )
        assert [t for t, _, _ in found] == [
            "App.Infrastructure.Doctrine.UserRepository",
            "App.Support.helper",
            "App.Application",
        ]

    def test_rust_use_forms(self):
        found = parse_rust(
            "use std::fmt;\npub use crate::infrastructure::db::Pool;\n"
            "pub(crate) use crate::application::{a, b};\nextern crate serde;\n"
        )
        assert [t for t, _, _ in found] == [
            "std.fmt",
            "crate.infrastructure.db.Pool",
            "crate.application",
            "serde",
        ]

    def test_dart_imports(self):
        found = parse_dart(
            "import 'package:flutter/material.dart';\n"
            'import "package:shop/features/auth/data/api.dart";\n'
            "import '../data/models.dart';\nexport 'src/a.dart';\n"
        )
        assert [t for t, _, _ in found] == [
            "package:flutter/material.dart",
            "package:shop/features/auth/data/api.dart",
            "../data/models.dart",
            "src/a.dart",
        ]

    def test_swift_imports(self):
        found = parse_swift(
            "import Foundation\n@testable import Infrastructure\nimport struct Domain.User\n"
        )
        assert [t for t, _, _ in found] == [
            "Foundation",
            "Infrastructure",
            "Domain.User",
        ]


# ---------------------------------------------------------------------------
# Layers and violations, one stack per case
# ---------------------------------------------------------------------------


def _dotnet(root: Path) -> list[tuple[str, str]]:
    for name in ("Domain", "Application", "Infrastructure", "Api"):
        _write(root, f"src/Shop.{name}/Shop.{name}.csproj", "<Project />")
    _write(
        root,
        "src/Shop.Domain/Users/User.cs",
        "using System;\nusing Shop.Infrastructure.Persistence;\nnamespace Shop.Domain.Users;\n",
    )
    _write(
        root,
        "src/Shop.Application/Users/CreateUser.cs",
        "using Shop.Domain.Users;\nnamespace Shop.Application.Users;\n",
    )
    _write(
        root,
        "src/Shop.Infrastructure/Persistence/Db.cs",
        "using Shop.Application.Users;\nusing Shop.Domain.Users;\n",
    )
    _write(root, "src/Shop.Api/Program.cs", "using Shop.Infrastructure.Persistence;\n")
    _write(
        root,
        "src/Shop.Application/Shop.Application.csproj",
        '<Project><ItemGroup><ProjectReference Include="..\\Shop.Api\\Shop.Api.csproj" />'
        "</ItemGroup></Project>",
    )
    return [
        ("src/Shop.Application/Shop.Application.csproj", "Shop.Api"),
        ("src/Shop.Domain/Users/User.cs", "Shop.Infrastructure.Persistence"),
    ]


def _dotnet_folders(root: Path) -> list[tuple[str, str]]:
    _write(
        root,
        "Shop.Api/Shop.Api.csproj",
        "<Project><PropertyGroup><RootNamespace>Acme.Shop</RootNamespace></PropertyGroup></Project>",
    )
    _write(
        root,
        "Shop.Api/Domain/Order.cs",
        "using Acme.Shop.Application.Orders;\nusing Microsoft.EntityFrameworkCore;\n",
    )
    _write(
        root, "Shop.Api/Application/Orders/PlaceOrder.cs", "using Acme.Shop.Domain;\n"
    )
    _write(root, "Shop.Api/Infrastructure/Repo.cs", "using Acme.Shop.Domain;\n")
    return [("Shop.Api/Domain/Order.cs", "Acme.Shop.Application.Orders")]


def _maven_modules(root: Path) -> list[tuple[str, str]]:
    _write(root, "pom.xml", "<project/>")
    _write(
        root,
        "shop-domain/src/main/java/com/acme/shop/domain/Order.java",
        "package com.acme.shop.domain;\nimport com.acme.shop.infrastructure.jpa.OrderEntity;\n",
    )
    _write(
        root,
        "shop-application/src/main/java/com/acme/shop/application/PlaceOrder.java",
        "package com.acme.shop.application;\nimport com.acme.shop.domain.Order;\n",
    )
    _write(
        root,
        "shop-infrastructure/src/main/java/com/acme/shop/infrastructure/jpa/OrderEntity.java",
        "package com.acme.shop.infrastructure.jpa;\nimport com.acme.shop.domain.Order;\n",
    )
    return [
        (
            "shop-domain/src/main/java/com/acme/shop/domain/Order.java",
            "com.acme.shop.infrastructure.jpa.OrderEntity",
        )
    ]


def _kotlin_packages(root: Path) -> list[tuple[str, str]]:
    base = "app/src/main/kotlin/com/acme/notes"
    _write(
        root,
        f"{base}/domain/Note.kt",
        "package com.acme.notes.domain\nimport com.acme.notes.ui.NoteScreen\n",
    )
    _write(
        root,
        f"{base}/data/NoteDao.kt",
        "package com.acme.notes.data\nimport com.acme.notes.domain.Note\n",
    )
    _write(
        root,
        f"{base}/ui/NoteScreen.kt",
        "package com.acme.notes.ui\nimport com.acme.notes.data.NoteDao\n",
    )
    return [(f"{base}/domain/Note.kt", "com.acme.notes.ui.NoteScreen")]


def _go(root: Path) -> list[tuple[str, str]]:
    _write(root, "go.mod", "module github.com/acme/shop\n\ngo 1.23\n")
    _write(
        root,
        "internal/domain/order.go",
        'package domain\n\nimport (\n\t"fmt"\n\t"github.com/acme/shop/internal/application"\n)\n',
    )
    _write(
        root,
        "internal/application/place.go",
        'package application\n\nimport "github.com/acme/shop/internal/domain"\n',
    )
    _write(
        root,
        "internal/infrastructure/pg.go",
        'package infrastructure\n\nimport "github.com/acme/shop/internal/domain"\n',
    )
    return [("internal/domain/order.go", "github.com/acme/shop/internal/application")]


def _php(root: Path) -> list[tuple[str, str]]:
    _write(root, "composer.json", '{"autoload": {"psr-4": {"App\\\\": "src/"}}}')
    _write(
        root,
        "src/Domain/User.php",
        "<?php\nnamespace App\\Domain;\nuse App\\Infrastructure\\Doctrine\\UserRepository;\n",
    )
    _write(root, "src/Application/CreateUser.php", "<?php\nuse App\\Domain\\User;\n")
    _write(
        root,
        "src/Infrastructure/Doctrine/UserRepository.php",
        "<?php\nuse App\\Domain\\User;\n",
    )
    return [("src/Domain/User.php", "App.Infrastructure.Doctrine.UserRepository")]


def _rust(root: Path) -> list[tuple[str, str]]:
    _write(root, "Cargo.toml", '[package]\nname = "shop-core"\nversion = "0.1.0"\n')
    _write(
        root,
        "src/domain/order.rs",
        "use crate::infrastructure::db::Pool;\nuse std::fmt;\n",
    )
    _write(root, "src/application/place.rs", "use crate::domain::order::Order;\n")
    _write(root, "src/infrastructure/db.rs", "use shop_core::domain::order::Order;\n")
    return [("src/domain/order.rs", "crate.infrastructure.db.Pool")]


def _flutter(root: Path) -> list[tuple[str, str]]:
    _write(root, "pubspec.yaml", "name: shop\nversion: 1.0.0\n")
    base = "lib/features/auth"
    _write(
        root,
        f"{base}/domain/user.dart",
        "import 'package:shop/features/auth/presentation/login_page.dart';\n",
    )
    _write(
        root,
        f"{base}/data/user_api.dart",
        "import 'package:shop/features/auth/domain/user.dart';\n",
    )
    _write(
        root,
        f"{base}/presentation/login_page.dart",
        "import 'package:flutter/material.dart';\n",
    )
    return [
        (
            f"{base}/domain/user.dart",
            "package:shop/features/auth/presentation/login_page.dart",
        )
    ]


def _swift_package(root: Path) -> list[tuple[str, str]]:
    _write(root, "Package.swift", "// swift-tools-version:5.9\n")
    _write(
        root, "Sources/Domain/Order.swift", "import Foundation\nimport Infrastructure\n"
    )
    _write(root, "Sources/Application/PlaceOrder.swift", "import Domain\n")
    _write(root, "Sources/Infrastructure/Store.swift", "import Domain\n")
    return [("Sources/Domain/Order.swift", "Infrastructure")]


def _python(root: Path) -> list[tuple[str, str]]:
    for pkg in ("shop", "shop/domain", "shop/application", "shop/infrastructure"):
        _write(root, f"src/{pkg}/__init__.py")
    _write(
        root, "src/shop/domain/order.py", "from shop.infrastructure.db import Session\n"
    )
    _write(
        root, "src/shop/application/place.py", "from shop.domain.order import Order\n"
    )
    _write(root, "src/shop/infrastructure/db.py", "import os\n")
    return [("src/shop/domain/order.py", "shop.infrastructure.db")]


def _typescript(root: Path) -> list[tuple[str, str]]:
    _write(
        root, "src/domain/order.ts", "import { Repo } from '../infrastructure/repo';\n"
    )
    _write(
        root, "src/application/place.ts", "import { Order } from '../domain/order';\n"
    )
    _write(
        root, "src/infrastructure/repo.ts", "import { Order } from '../domain/order';\n"
    )
    return [("src/domain/order.ts", "../infrastructure/repo")]


STACKS = {
    "dotnet-projects": _dotnet,
    "dotnet-folders": _dotnet_folders,
    "maven-modules": _maven_modules,
    "kotlin-packages": _kotlin_packages,
    "go": _go,
    "php": _php,
    "rust": _rust,
    "flutter": _flutter,
    "swift": _swift_package,
    "python": _python,
    "typescript": _typescript,
}


@pytest.mark.parametrize("stack", sorted(STACKS))
def test_layer_violation_found_in_every_stack(tmp_path, stack):
    expected = STACKS[stack](tmp_path)
    assert _layer_findings(tmp_path) == sorted(expected)


def test_dotnet_layers_carry_namespaces_and_rules(tmp_path):
    _dotnet(tmp_path)
    layers = {layer.name: layer for layer in infer_clean_layers(tmp_path)}
    assert set(layers) == {"domain", "application", "infrastructure", "presentation"}
    assert "Shop.Domain" in layers["domain"].module_prefixes
    assert layers["domain"].forbidden_imports == [
        "application",
        "infrastructure",
        "presentation",
    ]
    assert layers["application"].forbidden_imports == ["infrastructure", "presentation"]
    assert layers["presentation"].forbidden_imports == []


def test_domain_framework_import_is_reported(tmp_path):
    _dotnet_folders(tmp_path)
    config = infer_architecture_config(tmp_path, {})
    report = ArchitectureRulesEngine(tmp_path, config).validate()
    forbidden = [
        (v.file, v.import_target)
        for v in report.warnings
        if v.type == "forbidden_import"
    ]
    assert forbidden == [("Shop.Api/Domain/Order.cs", "Microsoft.EntityFrameworkCore")]


def test_lone_folders_are_not_an_architecture(tmp_path):
    """`api/` and `core/` alone, or a domain without any other layer, infer nothing."""
    _write(tmp_path, "src/api/client.ts", "import x from '../core/x';\n")
    _write(tmp_path, "src/core/x.ts", "")
    _write(tmp_path, "lib/domain/user.dart", "")
    assert infer_clean_layers(tmp_path) == []


def test_build_outputs_are_skipped(tmp_path):
    _dotnet(tmp_path)
    _write(
        tmp_path,
        "src/Shop.Domain/obj/Debug/Generated.cs",
        "using Shop.Infrastructure.Persistence;\n",
    )
    _write(tmp_path, "node_modules/pkg/domain/a.ts", "import '../infrastructure/b';\n")
    findings = _layer_findings(tmp_path)
    assert all("/obj/" not in f and "node_modules" not in f for f, _ in findings)


def test_inferred_violations_are_warnings(tmp_path):
    _go(tmp_path)
    config = infer_architecture_config(tmp_path, {})
    report = ArchitectureRulesEngine(tmp_path, config).validate()
    assert report.passed is True
    assert report.violations == []
    assert any(w.type == "layer_violation" for w in report.warnings)


def test_layer_violation_names_both_layers(tmp_path):
    _go(tmp_path)
    config = infer_architecture_config(tmp_path, {})
    report = ArchitectureRulesEngine(tmp_path, config).validate()
    [finding] = [w for w in report.warnings if w.type == "layer_violation"]
    assert (finding.source_layer, finding.target_layer) == ("domain", "application")
    payload = finding.to_dict()
    assert payload["source_layer"] == "domain"
    assert payload["target_layer"] == "application"


def test_framework_packages_are_not_mistaken_for_layers(tmp_path):
    """Ktor's `application` or Spring Data's `domain` are not the project's layers."""
    _kotlin_packages(tmp_path)
    _write(
        tmp_path,
        "app/src/main/kotlin/com/acme/notes/domain/Clock.kt",
        "package com.acme.notes.domain\nimport io.ktor.server.application.Application\n"
        "import org.springframework.data.domain.Pageable\n",
    )
    findings = _layer_findings(tmp_path)
    assert all("Clock.kt" not in f for f, _ in findings)


def test_python_package_under_a_package_root(tmp_path):
    """`apps/backend/__init__.py` exists, yet code imports `harness.domain`."""
    for pkg in (
        "apps/backend",
        "apps/backend/harness",
        "apps/backend/harness/domain",
        "apps/backend/harness/application",
    ):
        _write(tmp_path, f"{pkg}/__init__.py")
    _write(
        tmp_path,
        "apps/backend/harness/domain/model.py",
        "from harness.application.service import run\n",
    )
    _write(
        tmp_path,
        "apps/backend/harness/application/service.py",
        "from harness.domain.model import Model\n",
    )
    assert _layer_findings(tmp_path) == [
        ("apps/backend/harness/domain/model.py", "harness.application.service")
    ]

"""Licence governance on every stack, with licences actually resolved.

The scan used to read five manifests (npm, PyPI, Cargo, Go) and take a
dependency's licence from the manifest only — where it never is. Every
dependency came out ``unknown`` and every scan failed; a .NET, Java, PHP,
Ruby or Dart project came out "0 dependencies, compliant". These tests hold
the three sources (manifest, installed copy, registry) and the manifests of
the other stacks.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from license_governance import resolvers
from license_governance.api import router
from license_governance.local_metadata import LocalLicenseResolver, detect_license_text
from license_governance.manifests import (
    parse_composer_json,
    parse_composer_lock,
    parse_gemfile_lock,
    parse_gradle,
    parse_msbuild_project,
    parse_packages_config,
    parse_pom,
    parse_pubspec_lock,
)
from license_governance.resolvers import LicenseResolution, deps_dev_resolver
from license_governance.scanner import (
    DependencyRecord,
    LicenseCategory,
    LicenseScanner,
    classify_license,
)

MIT_TEXT = (
    "MIT License\n\nCopyright (c) 2024\n\nPermission is hereby granted, free of charge, "
    "to any person obtaining a copy of this software"
)
APACHE_TEXT = (
    "Apache License\nVersion 2.0, January 2004\nhttp://www.apache.org/licenses/"
)


def _write(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


@pytest.fixture(autouse=True)
def _no_network(monkeypatch: pytest.MonkeyPatch) -> None:
    """A test that reaches a registry fails instead of calling the internet."""

    def refuse(url: str) -> None:
        raise AssertionError(f"unexpected network call: {url}")

    monkeypatch.setattr(resolvers, "_http_get_json", refuse)
    resolvers.reset_cache_for_tests()


@pytest.fixture
def home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """An empty home, so the machine's own caches never answer."""
    home = tmp_path / "home"
    home.mkdir()
    for var in ("NUGET_PACKAGES", "CARGO_HOME", "GOPATH", "GOMODCACHE", "PUB_CACHE"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))
    return home


# ---------------------------------------------------------------------------
# Licence names as Maven, PyPI and NuGet write them


@pytest.mark.parametrize(
    ("raw", "category"),
    [
        ("The Apache Software License, Version 2.0", LicenseCategory.PERMISSIVE),
        ("MIT License", LicenseCategory.PERMISSIVE),
        ("BSD License", LicenseCategory.PERMISSIVE),
        ("Eclipse Public License - v 2.0", LicenseCategory.WEAK_COPYLEFT),
        ("GNU General Public License v3 (GPLv3)", LicenseCategory.STRONG_COPYLEFT),
        ("GNU Lesser General Public License v2.1", LicenseCategory.WEAK_COPYLEFT),
        ("GNU Affero General Public License v3", LicenseCategory.NETWORK_COPYLEFT),
        ("Mozilla Public License 2.0 (MPL 2.0)", LicenseCategory.WEAK_COPYLEFT),
        ("Some Vendor EULA v7", LicenseCategory.UNKNOWN),
    ],
)
def test_written_out_licence_names_classify(
    raw: str, category: LicenseCategory
) -> None:
    assert classify_license(raw) == category


def test_licence_text_is_recognised() -> None:
    assert detect_license_text(MIT_TEXT) == "MIT"
    assert detect_license_text(APACHE_TEXT) == "Apache-2.0"
    assert detect_license_text("All rights reserved.") is None


# ---------------------------------------------------------------------------
# Manifests of the other stacks


def test_csproj_package_references(tmp_path: Path) -> None:
    csproj = _write(
        tmp_path / "Api" / "Api.csproj",
        """<Project Sdk="Microsoft.NET.Sdk.Web">
  <ItemGroup>
    <PackageReference Include="MediatR" Version="12.4.1" />
    <PackageReference Include="StyleCop.Analyzers" Version="1.1.118" PrivateAssets="all" />
    <PackageReference Include="Serilog"><Version>4.0.0</Version></PackageReference>
  </ItemGroup>
</Project>""",
    )
    deps = {d.name: d for d in parse_msbuild_project(csproj)}
    assert deps["MediatR"].version == "12.4.1"
    assert deps["MediatR"].ecosystem == "nuget"
    assert deps["Serilog"].version == "4.0.0"
    assert deps["StyleCop.Analyzers"].is_direct is False


def test_central_package_versions_and_packages_config(tmp_path: Path) -> None:
    props = _write(
        tmp_path / "Directory.Packages.props",
        '<Project><ItemGroup><PackageVersion Include="FluentValidation" Version="11.9.0" />'
        "</ItemGroup></Project>",
    )
    legacy = _write(
        tmp_path / "packages.config",
        '<packages><package id="Newtonsoft.Json" version="13.0.3" /></packages>',
    )
    assert [d.name for d in parse_msbuild_project(props)] == ["FluentValidation"]
    assert [(d.name, d.version) for d in parse_packages_config(legacy)] == [
        ("Newtonsoft.Json", "13.0.3")
    ]


def test_maven_and_gradle(tmp_path: Path) -> None:
    pom = _write(
        tmp_path / "pom.xml",
        """<project xmlns="http://maven.apache.org/POM/4.0.0"><dependencies>
  <dependency><groupId>org.slf4j</groupId><artifactId>slf4j-api</artifactId><version>2.0.13</version></dependency>
  <dependency><groupId>org.junit.jupiter</groupId><artifactId>junit-jupiter</artifactId><scope>test</scope></dependency>
</dependencies></project>""",
    )
    deps = {d.name: d for d in parse_pom(pom)}
    assert deps["org.slf4j:slf4j-api"].version == "2.0.13"
    assert deps["org.junit.jupiter:junit-jupiter"].is_direct is False

    gradle = _write(
        tmp_path / "app" / "build.gradle.kts",
        'dependencies {\n  implementation("com.squareup.okhttp3:okhttp:4.12.0")\n'
        '  testImplementation("io.kotest:kotest-runner-junit5:5.9.1")\n}\n',
    )
    deps = {d.name: d for d in parse_gradle(gradle)}
    assert deps["com.squareup.okhttp3:okhttp"].version == "4.12.0"
    assert deps["io.kotest:kotest-runner-junit5"].is_direct is False


def test_composer_lock_carries_the_licence(tmp_path: Path) -> None:
    lock = _write(
        tmp_path / "composer.lock",
        json.dumps(
            {
                "packages": [
                    {"name": "monolog/monolog", "version": "3.6.0", "license": ["MIT"]}
                ],
                "packages-dev": [
                    {
                        "name": "phpunit/phpunit",
                        "version": "11.0.0",
                        "license": ["BSD-3-Clause"],
                    }
                ],
            }
        ),
    )
    deps = {d.name: d for d in parse_composer_lock(lock)}
    assert deps["monolog/monolog"].declared_license == "MIT"
    assert deps["phpunit/phpunit"].is_direct is False
    # composer.json beside a lock adds nothing: the lock already lists it all.
    manifest = _write(
        tmp_path / "composer.json", '{"require": {"php": ">=8.2", "a/b": "^1"}}'
    )
    assert parse_composer_json(manifest) == []
    alone = _write(
        tmp_path / "solo" / "composer.json",
        '{"require": {"php": ">=8.2", "a/b": "^1"}}',
    )
    assert [d.name for d in parse_composer_json(alone)] == ["a/b"]


def test_gemfile_and_pubspec_locks(tmp_path: Path) -> None:
    gemfile = _write(
        tmp_path / "Gemfile.lock",
        "GEM\n  remote: https://rubygems.org/\n  specs:\n    rack (3.0.8)\n    rails (7.1.3)\n"
        "      actionpack (= 7.1.3)\n\nPLATFORMS\n  ruby\n",
    )
    assert [(d.name, d.version) for d in parse_gemfile_lock(gemfile)] == [
        ("rack", "3.0.8"),
        ("rails", "7.1.3"),
    ]
    pubspec = _write(
        tmp_path / "pubspec.lock",
        """packages:
  http:
    dependency: "direct main"
    description:
      name: http
      url: "https://pub.dev"
    source: hosted
    version: "1.2.1"
  flutter:
    dependency: "direct main"
    description: flutter
    source: sdk
    version: "0.0.0"
""",
    )
    deps = parse_pubspec_lock(pubspec)
    assert [(d.name, d.version, d.ecosystem) for d in deps] == [
        ("http", "1.2.1", "pub")
    ]


# ---------------------------------------------------------------------------
# Installed copies


def test_installed_npm_and_python_packages(tmp_path: Path, home: Path) -> None:
    _write(tmp_path / "node_modules" / "react" / "package.json", '{"license": "MIT"}')
    _write(tmp_path / "node_modules" / "left-pad" / "package.json", "{}")
    _write(tmp_path / "node_modules" / "left-pad" / "LICENSE", MIT_TEXT)
    _write(
        tmp_path
        / ".venv"
        / "lib"
        / "python3.12"
        / "site-packages"
        / "Flask-3.0.0.dist-info"
        / "METADATA",
        "Metadata-Version: 2.1\nName: Flask\nClassifier: License :: OSI Approved :: BSD License\n\nbody",
    )
    _write(
        tmp_path
        / ".venv"
        / "lib"
        / "python3.12"
        / "site-packages"
        / "httpx-0.27.0.dist-info"
        / "METADATA",
        "Metadata-Version: 2.4\nName: httpx\nLicense-Expression: BSD-3-Clause\n\n",
    )
    local = LocalLicenseResolver(tmp_path)
    assert local(DependencyRecord("react", "^19", "npm")) == "MIT"
    assert local(DependencyRecord("left-pad", "^1", "npm")) == "MIT"
    assert local(DependencyRecord("flask", ">=3", "pypi")) == "BSD License"
    assert local(DependencyRecord("httpx", "", "pypi")) == "BSD-3-Clause"
    assert local(DependencyRecord("absent", "1", "npm")) is None


def test_installed_nuget_cargo_go_maven_pub(tmp_path: Path, home: Path) -> None:
    _write(
        home / ".nuget" / "packages" / "mediatr" / "12.4.1" / "mediatr.nuspec",
        '<package><metadata><license type="expression">Apache-2.0</license></metadata></package>',
    )
    _write(
        home / ".nuget" / "packages" / "oldlib" / "1.0.0" / "oldlib.nuspec",
        "<package><metadata><licenseUrl>https://opensource.org/licenses/MIT</licenseUrl>"
        "</metadata></package>",
    )
    _write(
        home
        / ".cargo"
        / "registry"
        / "src"
        / "index.crates.io-x"
        / "serde-1.0.200"
        / "Cargo.toml",
        '[package]\nname = "serde"\nlicense = "MIT OR Apache-2.0"\n',
    )
    _write(
        home
        / "go"
        / "pkg"
        / "mod"
        / "github.com"
        / "!burnt!sushi"
        / "toml@v1.3.2"
        / "LICENSE",
        MIT_TEXT,
    )
    _write(
        home
        / ".m2"
        / "repository"
        / "org"
        / "slf4j"
        / "slf4j-api"
        / "2.0.13"
        / "slf4j-api-2.0.13.pom",
        "<project><licenses><license><name>MIT License</name></license></licenses></project>",
    )
    _write(
        home / ".pub-cache" / "hosted" / "pub.dev" / "http-1.2.1" / "LICENSE",
        APACHE_TEXT,
    )

    local = LocalLicenseResolver(tmp_path)
    assert local(DependencyRecord("MediatR", "12.4.1", "nuget")) == "Apache-2.0"
    # A range picks the highest installed version.
    assert local(DependencyRecord("OldLib", "[1.0,2.0)", "nuget")) == "MIT"
    assert local(DependencyRecord("serde", "1.0", "cargo")) == "MIT OR Apache-2.0"
    assert (
        local(DependencyRecord("github.com/BurntSushi/toml", "v1.3.2", "go")) == "MIT"
    )
    assert (
        local(DependencyRecord("org.slf4j:slf4j-api", "2.0.13", "maven"))
        == "MIT License"
    )
    assert local(DependencyRecord("http", "1.2.1", "pub")) == "Apache-2.0"


# ---------------------------------------------------------------------------
# Registry and the order of the three sources


def test_deps_dev_resolves_a_range_through_the_default_version(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []

    def fake(url: str) -> dict:
        calls.append(url)
        if url.endswith("/versions/2.0.13"):
            return {"licenses": ["MIT"]}
        return {
            "versions": [
                {"versionKey": {"version": "1.7.36"}, "isDefault": False},
                {"versionKey": {"version": "2.0.13"}, "isDefault": True},
            ]
        }

    monkeypatch.setattr(resolvers, "_http_get_json", fake)
    dep = DependencyRecord("org.slf4j:slf4j-api", "${slf4j.version}", "maven")
    assert deps_dev_resolver(dep) == "MIT"
    assert (
        calls[0]
        == "https://api.deps.dev/v3/systems/MAVEN/packages/org.slf4j%3Aslf4j-api"
    )


def test_resolution_order_and_offline() -> None:
    asked: list[str] = []

    def registry(dep: DependencyRecord) -> str | None:
        asked.append(dep.name)
        return "Apache-2.0"

    def local(dep: DependencyRecord) -> str | None:
        return "MIT" if dep.name == "installed" else None

    resolution = LicenseResolution(local=local, online=True, registry=registry)
    declared = DependencyRecord(
        "locked", "1", "composer", declared_license="BSD-3-Clause"
    )
    installed = DependencyRecord("installed", "1", "npm")
    remote = DependencyRecord("remote", "1", "npm")
    assert resolution(declared) == "BSD-3-Clause"
    assert resolution(installed) == "MIT"
    assert resolution(remote) == "Apache-2.0"
    assert asked == ["remote"]
    assert resolution.source_of(declared) == "manifest"
    assert resolution.source_of(installed) == "installed"
    assert resolution.source_of(remote) == "registry"

    offline = LicenseResolution(local=local, online=False, registry=registry)
    assert offline(DependencyRecord("other", "1", "npm")) is None
    assert asked == ["remote"]


def test_dotnet_project_scan_resolves_from_the_nuget_cache(
    tmp_path: Path, home: Path
) -> None:
    """A Clean Architecture .NET solution used to scan as 0 dependencies."""
    _write(
        tmp_path / "src" / "Shop.Api" / "Shop.Api.csproj",
        '<Project><ItemGroup><PackageReference Include="MediatR" Version="12.4.1" />'
        "</ItemGroup></Project>",
    )
    _write(tmp_path / "src" / "Shop.Api" / "obj" / "x.csproj", "<Project/>")
    _write(
        home / ".nuget" / "packages" / "mediatr" / "12.4.1" / "mediatr.nuspec",
        '<package><metadata><license type="expression">Apache-2.0</license></metadata></package>',
    )
    scanner = LicenseScanner(
        tmp_path,
        resolver=LicenseResolution(local=LocalLicenseResolver(tmp_path), online=False),
    )
    report = scanner.scan()
    assert [d.name for d in report.dependencies] == ["MediatR"]
    assert report.dependencies[0].license_source == "installed"
    assert report.passed
    assert report.summary["unresolved"] == 0
    assert report.summary["by_source"] == {"installed": 1}


@pytest.fixture
def client() -> TestClient:
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def test_scan_endpoint_reads_installed_licences(
    client: TestClient, tmp_path: Path, home: Path
) -> None:
    _write(tmp_path / "package.json", '{"dependencies": {"react": "^19.0.0"}}')
    _write(tmp_path / "node_modules" / "react" / "package.json", '{"license": "MIT"}')
    body = client.post(
        "/api/license-governance/scan",
        json={"project_path": str(tmp_path), "online": False},
    ).json()
    assert body["success"] is True
    assert body["report"]["passed"] is True
    assert body["report"]["dependencies"][0]["license_source"] == "installed"


def test_strict_offline_project_never_reaches_a_registry(
    client: TestClient, tmp_path: Path, home: Path
) -> None:
    _write(tmp_path / ".workpilot" / "offline-mode.json", '{"airgapStrict": true}')
    _write(tmp_path / "package.json", '{"dependencies": {"left-pad": "^1.0.0"}}')
    # `_no_network` turns any registry call into a failure.
    body = client.post(
        "/api/license-governance/scan",
        json={"project_path": str(tmp_path), "online": True},
    ).json()
    assert body["success"] is True
    assert body["online"] is False
    assert body["report"]["summary"]["unresolved"] == 1

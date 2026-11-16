"""Manifests as projects actually write them, and as they sometimes break.

A manifest is a file of the scanned project: whatever its shape, a scan reads
what it can and goes on. The happy paths of each ecosystem are in
`test_scanner.py` and `test_all_stacks.py`; this file holds the other shapes
(a list where a table was expected, a section that is a string, unreadable
files), the licence names the classifier recognises from their wording, and
the routes' refusals.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from license_governance import api as api_module
from license_governance import resolvers
from license_governance.api import router
from license_governance.manifests import (
    parse_composer_json,
    parse_composer_lock,
    parse_msbuild_project,
    parse_packages_config,
    parse_pom,
)
from license_governance.scanner import (
    LicenseCategory,
    LicensePolicy,
    LicenseScanner,
    _parse_cargo_toml,
    _parse_go_mod,
    _parse_package_json,
    _parse_pyproject_toml,
    _parse_requirements_txt,
    classify_license,
)


def _write(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def _names(deps) -> list[tuple[str, str, bool]]:
    return [(d.name, d.version, d.is_direct) for d in deps]


# ---------------------------------------------------------------------------
# licence names written out in words


@pytest.mark.parametrize(
    ("written", "category"),
    [
        ("Mozilla Public License 2.0 (MPL 2.0)", LicenseCategory.WEAK_COPYLEFT),
        ("Eclipse Public License - v 1.0", LicenseCategory.WEAK_COPYLEFT),
        ("Eclipse Public License v2.0", LicenseCategory.WEAK_COPYLEFT),
        ("COMMON DEVELOPMENT AND DISTRIBUTION LICENSE", LicenseCategory.WEAK_COPYLEFT),
        ("ISC License (ISCL)", LicenseCategory.PERMISSIVE),
        ("New BSD License", LicenseCategory.PERMISSIVE),
        ("Simplified BSD", LicenseCategory.PERMISSIVE),
        ("The Unlicense (Unlicense)", LicenseCategory.PUBLIC_DOMAIN),
        ("Public Domain", LicenseCategory.PUBLIC_DOMAIN),
        ("zlib/libpng License", LicenseCategory.PERMISSIVE),
        ("Boost Software License", LicenseCategory.PERMISSIVE),
        ("Python Software Foundation License", LicenseCategory.PERMISSIVE),
        ("psf", LicenseCategory.PERMISSIVE),
        ("Expat", LicenseCategory.PERMISSIVE),
        ("Some Vendor Licence", LicenseCategory.UNKNOWN),
    ],
)
def test_a_licence_written_in_words_is_classified(written, category):
    assert classify_license(written) is category


def test_saas_safe_is_the_permissive_policy():
    assert LicensePolicy.saas_safe() == LicensePolicy.permissive_only()


# ---------------------------------------------------------------------------
# npm, PyPI, Cargo, Go


class TestCoreManifests:
    @pytest.mark.parametrize(
        "body",
        [
            '["not", "an", "object"]',
            '{"dependencies": ["react"]}',
            '{"dependencies": "react"}',
        ],
    )
    def test_a_package_json_of_another_shape_has_no_dependencies(self, tmp_path, body):
        assert _parse_package_json(_write(tmp_path / "package.json", body)) == []

    def test_a_package_json_that_is_not_utf8_has_no_dependencies(self, tmp_path):
        path = tmp_path / "package.json"
        path.write_bytes(b'{"dependencies": {"r\xe9act": "1"}}')

        assert _parse_package_json(path) == []

    def test_requirements_skip_options_and_unparsable_lines(self, tmp_path):
        path = _write(
            tmp_path / "requirements.txt",
            "-r base.txt\n[extra]\nrequests>=2.31 ; python_version>'3'\nflask\n",
        )

        assert _names(_parse_requirements_txt(path)) == [
            ("requests", ">=2.31", True),
            ("flask", "", True),
        ]

    def test_unreadable_text_manifests_have_no_dependencies(self, tmp_path):
        for name in ("requirements.txt", "go.mod"):
            (tmp_path / name).mkdir()

        assert _parse_requirements_txt(tmp_path / "requirements.txt") == []
        assert _parse_go_mod(tmp_path / "go.mod") == []

    def test_pyproject_reads_pep_621_dependencies(self, tmp_path):
        path = _write(
            tmp_path / "pyproject.toml",
            '[project]\nname = "x"\ndependencies = ["httpx>=0.27", "rich", "  ", 7]\n',
        )

        assert _names(_parse_pyproject_toml(path)) == [
            ("httpx", ">=0.27", True),
            ("rich", "", True),
        ]

    @pytest.mark.parametrize(
        "body",
        [
            "not = [valid",
            'project = "a string"',
            '[project]\ndependencies = "httpx"',
            "[tool.poetry]\nname = 'x'",
        ],
    )
    def test_a_pyproject_of_another_shape_has_no_dependencies(self, tmp_path, body):
        assert _parse_pyproject_toml(_write(tmp_path / "pyproject.toml", body)) == []

    def test_cargo_reads_both_spellings_and_dev_dependencies(self, tmp_path):
        path = _write(
            tmp_path / "Cargo.toml",
            "[package]\nname = 'x'\n\n"
            "[dependencies]\n"
            'serde = "1.0"\n'
            'tokio = { version = "1.38", features = ["full"] }\n'
            'local = { path = "../local" }\n'
            "odd = 3\n\n"
            "[dev-dependencies]\n"
            'insta = "1.39"\n',
        )

        assert _names(_parse_cargo_toml(path)) == [
            ("serde", "1.0", True),
            ("tokio", "1.38", True),
            ("local", "", True),
            ("odd", "", True),
            ("insta", "1.39", False),
        ]

    @pytest.mark.parametrize("body", ["[dependencies", 'dependencies = "serde"'])
    def test_a_cargo_toml_of_another_shape_has_no_dependencies(self, tmp_path, body):
        assert _parse_cargo_toml(_write(tmp_path / "Cargo.toml", body)) == []

    def test_go_mod_single_line_requires(self, tmp_path):
        path = _write(
            tmp_path / "go.mod",
            "module example.com/x\n\n"
            "require github.com/pkg/errors v0.9.1\n"
            "require incomplete\n"
            "require (\n\tgolang.org/x/text v0.14.0\n\tlonely\n)\n",
        )

        assert _names(_parse_go_mod(path)) == [
            ("github.com/pkg/errors", "v0.9.1", True),
            ("golang.org/x/text", "v0.14.0", True),
        ]

    def test_without_a_resolver_the_manifest_licence_is_the_answer(self, tmp_path):
        _write(
            tmp_path / "composer.lock",
            '{"packages": [{"name": "a/b", "license": "MIT"}]}',
        )

        report = LicenseScanner(tmp_path).scan()

        assert report.dependencies[0].declared_license == "MIT"
        assert report.dependencies[0].license_source == ""
        assert report.passed


# ---------------------------------------------------------------------------
# .NET, Java, PHP


class TestOtherManifests:
    def test_an_unreadable_or_broken_xml_manifest_has_no_dependencies(self, tmp_path):
        (tmp_path / "App.csproj").mkdir()
        broken = _write(tmp_path / "pom.xml", "<project><dependencies>")
        _write(tmp_path / "packages.config", "<packages><package id=")

        assert parse_msbuild_project(tmp_path / "App.csproj") == []
        assert parse_pom(broken) == []
        assert parse_packages_config(tmp_path / "packages.config") == []

    def test_msbuild_references_without_a_name_are_dropped(self, tmp_path):
        path = _write(
            tmp_path / "App.csproj",
            "<Project><ItemGroup>"
            '<PackageReference Version="1.0" />'
            '<PackageReference Update="Serilog"><Version>3.1.1</Version></PackageReference>'
            '<PackageReference Include="Polly"><Version /><Other>x</Other></PackageReference>'
            "</ItemGroup></Project>",
        )

        assert _names(parse_msbuild_project(path)) == [
            ("Serilog", "3.1.1", True),
            ("Polly", "", True),
        ]

    def test_a_pom_dependency_without_coordinates_is_dropped(self, tmp_path):
        path = _write(
            tmp_path / "pom.xml",
            "<project><dependencies>"
            "<dependency><artifactId>lonely</artifactId></dependency>"
            "<dependency><groupId>g</groupId><artifactId>a</artifactId>"
            "<scope>provided</scope></dependency>"
            "</dependencies></project>",
        )

        assert _names(parse_pom(path)) == [("g:a", "", False)]

    @pytest.mark.parametrize(
        ("license_value", "read"),
        [("MIT", "MIT"), ("", None), (["MIT", "", 3], "MIT"), ({"x": 1}, None)],
    )
    def test_a_composer_lock_licence_in_any_spelling(
        self, tmp_path, license_value, read
    ):
        path = _write(
            tmp_path / "composer.lock",
            json.dumps({"packages": [{"name": "a/b", "license": license_value}]}),
        )

        assert parse_composer_lock(path)[0].declared_license == read

    @pytest.mark.parametrize(
        "body",
        [
            "{broken",
            "[1, 2]",
            '{"packages": "a/b"}',
            '{"packages": [{"name": ""}, {"name": 7}, "a/b", {"version": "1"}]}',
        ],
    )
    def test_a_composer_lock_of_another_shape_has_no_packages(self, tmp_path, body):
        assert parse_composer_lock(_write(tmp_path / "composer.lock", body)) == []

    @pytest.mark.parametrize(
        "body", ["{broken", '"a string"', '{"require": ["monolog/monolog"]}']
    )
    def test_a_composer_json_of_another_shape_has_no_packages(self, tmp_path, body):
        assert parse_composer_json(_write(tmp_path / "composer.json", body)) == []


# ---------------------------------------------------------------------------
# the routes


@pytest.fixture
def client(monkeypatch) -> TestClient:
    def refuse(url: str) -> None:
        raise AssertionError(f"unexpected network call: {url}")

    monkeypatch.setattr(resolvers, "_http_get_json", refuse)
    resolvers.reset_cache_for_tests()
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


class TestRoutes:
    @pytest.mark.parametrize("route", ["scan", "attribution"])
    def test_a_path_that_is_not_a_project_is_refused(self, client, tmp_path, route):
        body = client.post(
            f"/api/license-governance/{route}",
            json={"project_path": str(tmp_path / "missing")},
        ).json()

        assert body["success"] is False and body["error"]
        assert str(tmp_path) not in body["error"]

    def test_an_unknown_policy_is_refused_with_the_choices(self, client, tmp_path):
        body = client.post(
            "/api/license-governance/scan",
            json={"project_path": str(tmp_path), "policy": "anything_goes"},
        ).json()

        assert body["success"] is False
        assert "permissive_only" in body["error"]

    def test_an_unreadable_offline_policy_counts_as_strict(self, client, tmp_path):
        _write(tmp_path / ".workpilot" / "offline-mode.json", "{broken")
        _write(tmp_path / "package.json", '{"dependencies": {"left-pad": "1.0.0"}}')

        body = client.post(
            "/api/license-governance/scan",
            json={"project_path": str(tmp_path), "online": True},
        ).json()

        assert body["success"] is True and body["online"] is False

    @pytest.mark.parametrize(
        ("raw", "category", "permissive"),
        [
            ("MIT OR GPL-3.0", "permissive", True),
            ("CC0-1.0", "public_domain", True),
            ("AGPL-3.0", "network_copyleft", False),
        ],
    )
    def test_classify_names_the_category(self, client, raw, category, permissive):
        body = client.post(
            "/api/license-governance/classify", json={"license": raw}
        ).json()

        assert body == {
            "success": True,
            "license": raw,
            "category": category,
            "is_permissive": permissive,
        }

    @pytest.mark.parametrize("route", ["scan", "attribution"])
    def test_a_scan_that_fails_answers_without_its_details(
        self, client, tmp_path, monkeypatch, caplog, route
    ):
        def explode(self):
            raise RuntimeError(f"secret detail under {tmp_path}")

        monkeypatch.setattr(api_module.LicenseScanner, "scan", explode)

        with caplog.at_level(logging.ERROR):
            body = client.post(
                f"/api/license-governance/{route}",
                json={"project_path": str(tmp_path), "online": False},
            ).json()

        assert body["success"] is False
        assert "secret detail" not in body["error"]

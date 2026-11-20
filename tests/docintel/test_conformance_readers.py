"""Module graphs of every build system at their edges, and the checks on them.

`test_docintel.py` holds a clean-architecture solution and one repository per
build system against a diagram. This file covers what those leave out: a
manifest that does not parse, a module that is a test or names nothing, a
JS workspace declared the other way or with patterns that name no folder, a
Cargo workspace root, ceilings on diagrams and projects, a diagram too big or
gone, an ERD among the diagrams, and the section's longer reports.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from docintel import conformance
from docintel.conformance import (
    check_conformance,
    check_diagram,
    conformance_section,
    find_diagrams,
    read_module_references,
    read_project_references,
)
from docintel.models import DiagramEdge, DiagramModel, DiagramNode

from tests.test_docintel import CLEAN_ARCHI, _csproj


def write(root: Path, relative: str, text: str) -> Path:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def layered(*labels: str, arrows: tuple[tuple[str, str], ...] = ()) -> DiagramModel:
    return DiagramModel(
        format="drawio",
        nodes=[
            DiagramNode(id=label.lower() or "blank", label=label) for label in labels
        ],
        edges=[DiagramEdge(source=a.lower(), target=b.lower()) for a, b in arrows],
    )


def pom(root: Path, directory: str, artifact: str, *deps: str) -> None:
    body = "".join(f"<dependency>{d}</dependency>" for d in deps)
    write(
        root,
        f"{directory}/pom.xml",
        f"<project>{artifact}<dependencies>{body}</dependencies></project>",
    )


class TestDotnet:
    def test_a_csproj_that_does_not_parse_is_a_module_without_edges(self, tmp_path):
        _csproj(tmp_path, "Acme.Api", ["Acme.Domain"])
        _csproj(tmp_path, "Acme.Domain", [])
        write(tmp_path, "src/Acme.Broken/Acme.Broken.csproj", "<Project><unclosed")

        projects, references = read_project_references(tmp_path)

        assert set(projects) == {"Acme.Api", "Acme.Domain", "Acme.Broken"}
        assert references == [
            ("Acme.Api", "Acme.Domain", "src/Acme.Api/Acme.Api.csproj")
        ]

    def test_references_without_a_target_or_to_tests_are_left_out(self, tmp_path):
        write(
            tmp_path,
            "src/Acme.Api/Acme.Api.csproj",
            "<Project><ItemGroup>"
            '<ProjectReference Include="" />'
            '<ProjectReference Include="..\\Acme.Api.Tests\\Acme.Api.Tests.csproj" />'
            "</ItemGroup></Project>",
        )

        assert read_project_references(tmp_path)[1] == []

    def test_the_count_stops_at_its_ceiling(self, tmp_path, monkeypatch):
        for name in ("Acme.A", "Acme.B", "Acme.C"):
            _csproj(tmp_path, name, [])
        monkeypatch.setattr(conformance, "MAX_PROJECTS", 2)

        assert len(read_project_references(tmp_path)[0]) == 2


class TestJvm:
    def test_poms_that_name_no_module_add_none(self, tmp_path):
        pom(
            tmp_path,
            "api",
            "<artifactId>shop-api</artifactId>",
            "<artifactId>shop-domain</artifactId>",
            "<groupId>no-artifact</groupId>",
        )
        pom(tmp_path, "domain", "<artifactId>shop-domain</artifactId>")
        pom(tmp_path, "it", "<artifactId>shop-integration-tests</artifactId>")
        pom(tmp_path, "parent", "<groupId>only</groupId>")
        write(tmp_path, "broken/pom.xml", "<project><artifactId>x")

        modules, edges = read_module_references(tmp_path)

        assert set(modules) == {"shop-api", "shop-domain"}
        assert edges == [("shop-api", "shop-domain", "api/pom.xml")]

    def test_gradle_modules_without_a_build_or_for_tests_are_skipped(self, tmp_path):
        write(
            tmp_path,
            "settings.gradle",
            "include ':app', ':core', ':missing', ':app-tests'\n",
        )
        write(
            tmp_path,
            "app/build.gradle",
            "implementation project(':core')\nproject(':')\n",
        )
        write(tmp_path, "core/build.gradle", "")
        write(tmp_path, "app-tests/build.gradle", "implementation project(':app')\n")

        modules, edges = read_module_references(tmp_path)

        assert set(modules) == {"app", "core"}
        assert edges == [("app", "core", "app/build.gradle")]


class TestWorkspaces:
    def test_workspaces_declared_as_an_object_are_read(self, tmp_path):
        write(
            tmp_path,
            "package.json",
            json.dumps({"workspaces": {"packages": ["packages/*", "packages/*"]}}),
        )
        write(
            tmp_path,
            "packages/web/package.json",
            json.dumps({"name": "@shop/web", "dependencies": {"@shop/core": "1"}}),
        )
        write(
            tmp_path, "packages/core/package.json", json.dumps({"name": "@shop/core"})
        )
        write(tmp_path, "packages/e2e-tests/package.json", json.dumps({"name": "e2e"}))
        write(tmp_path, "packages/nameless/package.json", json.dumps({"private": True}))
        write(tmp_path, "packages/broken/package.json", "{")

        modules, edges = read_module_references(tmp_path)

        assert set(modules) == {"@shop/web", "@shop/core"}
        assert edges == [("@shop/web", "@shop/core", "packages/web/package.json")]

    @pytest.mark.parametrize("pattern", ["", "/", "/opt/*", "C:/work/*", "../*"])
    def test_a_pattern_that_names_no_folder_of_the_repository_is_ignored(
        self, tmp_path, pattern
    ):
        write(tmp_path, "package.json", json.dumps({"workspaces": [pattern, "apps/*"]}))
        write(tmp_path, "apps/a/package.json", json.dumps({"name": "a"}))
        write(tmp_path, "apps/b/package.json", json.dumps({"name": "b"}))

        assert set(read_module_references(tmp_path)[0]) == {"a", "b"}


class TestCargo:
    def test_a_workspace_root_and_a_test_crate_are_not_modules(self, tmp_path):
        write(tmp_path, "Cargo.toml", '[workspace]\nmembers = ["core", "it-tests"]\n')
        write(tmp_path, "core/Cargo.toml", '[package]\nname = "core"\n')
        write(tmp_path, "it-tests/Cargo.toml", '[package]\nname = "it-tests"\n')
        write(tmp_path, "odd/Cargo.toml", "[package]\nversion = '1'\n")

        assert set(read_module_references(tmp_path)[0]) == {"core"}

    def test_a_reader_that_cannot_read_is_skipped_for_the_next(
        self, tmp_path, monkeypatch
    ):
        write(tmp_path, "core/Cargo.toml", '[package]\nname = "core"\n')
        pom(tmp_path, "api", "<artifactId>shop-api</artifactId>")
        real = Path.read_text

        def read_text(self, *args, **kwargs):
            if self.name == "Cargo.toml":
                raise PermissionError(self)
            return real(self, *args, **kwargs)

        monkeypatch.setattr(Path, "read_text", read_text)

        assert set(read_module_references(tmp_path)[0]) == {"shop-api"}

    def test_the_readers_stop_at_the_ceiling(self, tmp_path, monkeypatch):
        pom(tmp_path, "a", "<artifactId>a</artifactId>")
        pom(tmp_path, "b", "<artifactId>b</artifactId>")
        write(tmp_path, "c/Cargo.toml", '[package]\nname = "c"\n')
        monkeypatch.setattr(conformance, "MAX_PROJECTS", 2)

        assert set(read_module_references(tmp_path)[0]) == {"a", "b"}


class TestTheCheck:
    def test_a_box_with_more_words_than_any_project_names_none(self):
        diagram = layered("Presentation Layer Of The Shop", "Domain", "")

        check, _ = check_diagram(diagram, "d.drawio", {"Acme.Domain": "x"}, [])

        assert check.status == "too-few-layers"
        assert check.layers == {"Domain": ["Acme.Domain"]}

    def test_a_reference_inside_one_layer_is_no_crossing(self):
        diagram = layered("Api", "Domain", arrows=(("Api", "Domain"),))
        projects = {"Acme.Api": "a", "Acme.Domain": "d", "Acme.Domain.Events": "e"}
        references = [
            ("Acme.Domain.Events", "Acme.Domain", "e"),
            ("Acme.Api", "Acme.Domain", "a"),
        ]

        check, findings = check_diagram(diagram, "d.drawio", projects, references)

        assert check.status == "checked" and findings == []


class TestRepository:
    @pytest.fixture
    def solution(self, tmp_path) -> Path:
        _csproj(tmp_path, "Acme.Api", ["Acme.Application"])
        _csproj(tmp_path, "Acme.Application", ["Acme.Domain"])
        _csproj(tmp_path, "Acme.Domain", ["Acme.Application"])
        _csproj(tmp_path, "Acme.Infrastructure", ["Acme.Application"])
        return tmp_path

    def test_the_diagrams_found_stop_at_their_ceiling(self, tmp_path, monkeypatch):
        write(tmp_path, "docs/a.drawio", CLEAN_ARCHI)
        write(tmp_path, "docs/b.drawio", CLEAN_ARCHI)
        monkeypatch.setattr(conformance, "MAX_DIAGRAMS", 1)

        assert [p.name for p in find_diagrams(tmp_path)] == ["a.drawio"]

    def test_a_diagram_too_big_gone_or_an_erd_is_not_checked(
        self, solution, monkeypatch
    ):
        write(solution, "docs/big.drawio", CLEAN_ARCHI + " " * 256)
        locked = write(solution, "docs/locked.drawio", CLEAN_ARCHI)
        write(
            solution,
            "docs/erd.drawio",
            CLEAN_ARCHI.replace(
                'edge="1" source="api"',
                'edge="1" style="endArrow=ERmany;" source="api"',
            ),
        )
        monkeypatch.setattr(conformance, "MAX_DIAGRAM_BYTES", len(CLEAN_ARCHI) + 64)
        real = Path.read_bytes

        def read_bytes(self):
            if self == locked:
                raise PermissionError(self)
            return real(self)

        monkeypatch.setattr(Path, "read_bytes", read_bytes)

        assert check_conformance(solution).checks == []

    def test_a_repository_that_cannot_be_read_says_so(self, solution, monkeypatch):
        write(solution, "docs/a.drawio", CLEAN_ARCHI)

        def unreadable(_root):
            raise PermissionError("locked")

        monkeypatch.setattr(conformance, "read_module_references", unreadable)

        assert check_conformance(solution).skipped == "unreadable"


class TestSection:
    def test_a_diagram_without_arrows_or_findings_lists_its_layers(self, tmp_path):
        _csproj(tmp_path, "Acme.Api", [])
        _csproj(tmp_path, "Acme.Domain", [])
        write(
            tmp_path,
            "docs/layers.drawio",
            CLEAN_ARCHI.replace('edge="1"', 'edge="0"'),
        )

        section = conformance_section(tmp_path)

        assert "- Api: Acme.Api" in section and "Allowed:" not in section
        assert "contrary to the diagram" not in section

    def test_more_findings_than_shown_are_counted(self, tmp_path, monkeypatch):
        _csproj(tmp_path, "Acme.Api", ["Acme.Application"])  # as drawn
        _csproj(tmp_path, "Acme.Application", ["Acme.Api", "Acme.Infrastructure"])
        _csproj(tmp_path, "Acme.Domain", ["Acme.Application", "Acme.Api"])
        _csproj(tmp_path, "Acme.Infrastructure", ["Acme.Api"])
        write(tmp_path, "docs/a.drawio", CLEAN_ARCHI)
        monkeypatch.setattr(conformance, "MAX_FINDINGS", 1)

        section = conformance_section(tmp_path)

        assert section.count("points backwards") + section.count("is not drawn") == 1
        assert "- … " in section and " more" in section

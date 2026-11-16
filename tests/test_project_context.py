"""What the QA prompts learn about a project from its index (`prompts_pkg/project_context.py`).

Each test writes the files a real project has, then asks.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest
from prompts_pkg.project_context import (
    detect_project_capabilities,
    get_mcp_tools_for_project,
    load_project_index,
    should_refresh_project_index,
)


def _index_file(project: Path) -> Path:
    return project / ".workpilot" / "project_index.json"


def _write_index(project: Path, content: str) -> Path:
    index = _index_file(project)
    index.parent.mkdir(parents=True, exist_ok=True)
    index.write_text(content, encoding="utf-8")
    return index


def _age(path: Path, seconds_ago: int) -> None:
    """Give a file an mtime in the past, so the order between files is certain."""
    stamp = path.stat().st_mtime - seconds_ago
    os.utime(path, (stamp, stamp))


# --- loading the index ----------------------------------------------------------


def test_the_index_is_read_from_the_workpilot_folder(tmp_path):
    _write_index(tmp_path, json.dumps({"services": {"web": {"framework": "react"}}}))

    assert load_project_index(tmp_path) == {"services": {"web": {"framework": "react"}}}


def test_a_project_without_an_index_has_an_empty_one(tmp_path):
    assert load_project_index(tmp_path) == {}


@pytest.mark.parametrize("content", ["{broken", "[1, 2]", '"text"'])
def test_an_index_that_is_not_an_object_counts_as_empty(tmp_path, content):
    _write_index(tmp_path, content)

    assert load_project_index(tmp_path) == {}


def test_an_index_that_is_not_utf8_counts_as_empty(tmp_path):
    _index_file(tmp_path).parent.mkdir(parents=True)
    _index_file(tmp_path).write_bytes(b"\xff\xfe{\xff}")

    assert load_project_index(tmp_path) == {}


def test_an_unreadable_index_counts_as_empty(tmp_path):
    _index_file(tmp_path).mkdir(parents=True)  # reading a folder fails

    assert load_project_index(tmp_path) == {}


# --- capabilities -------------------------------------------------------------------


def _caps(*services, as_list: bool = False) -> dict:
    if as_list:
        return detect_project_capabilities({"services": list(services)})
    return detect_project_capabilities(
        {"services": {f"s{i}": s for i, s in enumerate(services)}}
    )


def _true(caps: dict) -> set[str]:
    return {name for name, value in caps.items() if value}


def test_an_empty_index_has_no_capability():
    assert _true(detect_project_capabilities({})) == set()


@pytest.mark.parametrize("index", [[], "x", None, {"services": "web"}, {"services": 3}])
def test_an_odd_index_has_no_capability(index):
    assert _true(detect_project_capabilities(index)) == set()


def test_an_electron_app_with_vite_is_a_desktop_app_not_a_web_frontend():
    caps = _caps({"dependencies": ["Electron"], "dev_dependencies": ["vite"]})

    assert _true(caps) == {"is_electron"}


def test_an_electron_scoped_package_also_means_electron():
    assert _true(_caps({"dev_dependencies": ["@electron/remote"]})) == {"is_electron"}


@pytest.mark.parametrize("dep", ["@tauri-apps/api", "tauri"])
def test_tauri(dep):
    assert _true(_caps({"dependencies": [dep]})) == {"is_tauri"}


def test_expo_and_react_native():
    caps = _caps({"dependencies": ["expo", "react-native"]})

    assert _true(caps) == {"is_expo", "is_react_native"}


@pytest.mark.parametrize("framework", ["react", "Vue", "svelte", "angular", "solid"])
def test_a_web_framework_is_a_web_frontend(framework):
    assert _true(_caps({"framework": framework})) == {"is_web_frontend"}


@pytest.mark.parametrize(
    ("service", "flag"),
    [
        ({"framework": "Next.js"}, "is_nextjs"),
        ({"framework": "next"}, "is_nextjs"),
        ({"dependencies": ["next"]}, "is_nextjs"),
        ({"framework": "nuxt"}, "is_nuxt"),
        ({"dependencies": ["nuxt"]}, "is_nuxt"),
    ],
)
def test_a_meta_framework_is_also_a_web_frontend(service, flag):
    assert _true(_caps(service)) == {flag, "is_web_frontend"}


def test_vite_alone_is_a_web_frontend():
    assert _true(_caps({"dev_dependencies": ["vite"]})) == {"is_web_frontend"}


def test_api_routes_and_a_database_are_seen():
    caps = _caps({"api": {"routes": ["/users"]}, "database": "postgres"})

    assert _true(caps) == {"has_api", "has_database"}


def test_an_api_without_routes_is_not_an_api():
    assert _true(_caps({"api": {"routes": []}}, {"api": ["/x"]})) == set()


@pytest.mark.parametrize("orm", ["prisma", "SQLAlchemy", "django", "mongoose"])
def test_an_orm_dependency_means_a_database(orm):
    assert _true(_caps({"dependencies": [orm]})) == {"has_database"}


def test_dependencies_given_as_a_name_to_version_map_are_read():
    caps = _caps({"dependencies": {"expo": "52", "prisma": "6"}})

    assert _true(caps) == {"is_expo", "has_database"}


@pytest.mark.parametrize("deps", ["next", 7, None, [3, None, "expo"]])
def test_odd_dependency_fields_are_ignored_not_spelled_out(deps):
    """A string is not a list of one-letter packages, and a number does not break."""
    caps = _caps({"dependencies": deps})

    assert _true(caps) == ({"is_expo"} if isinstance(deps, list) else set())


def test_a_services_list_and_its_odd_entries(tmp_path):
    caps = _caps("not a service", {"dependencies": ["tauri"]}, as_list=True)

    assert _true(caps) == {"is_tauri"}


def test_capabilities_add_up_across_services():
    caps = _caps({"framework": "react"}, {"dependencies": ["sqlalchemy"]})

    assert _true(caps) == {"is_web_frontend", "has_database"}


# --- which tool docs the QA agent gets -------------------------------------------


def test_each_capability_brings_its_tool_doc():
    caps = {
        "is_electron": False,
        "is_tauri": True,
        "is_web_frontend": True,
        "has_database": True,
        "has_api": True,
    }

    assert get_mcp_tools_for_project(caps) == [
        "mcp_tools/puppeteer_browser.md",
        "mcp_tools/database_validation.md",
        "mcp_tools/api_validation.md",
    ]


def test_an_electron_app_is_checked_in_electron_not_in_a_browser():
    tools = get_mcp_tools_for_project({"is_electron": True, "is_web_frontend": True})

    assert tools == ["mcp_tools/electron_validation.md"]


def test_no_capability_no_tool_doc():
    assert get_mcp_tools_for_project({}) == []


def test_the_tool_docs_named_exist():
    prompts = Path(__file__).resolve().parents[1] / "apps" / "backend" / "prompts"
    every = get_mcp_tools_for_project(
        {"is_electron": True, "is_tauri": True, "has_database": True, "has_api": True}
    ) + get_mcp_tools_for_project({"is_web_frontend": True})

    assert [name for name in every if not (prompts / name).is_file()] == []


# --- when the index must be rebuilt ---------------------------------------------------


def test_without_an_index_it_must_be_built(tmp_path):
    assert should_refresh_project_index(tmp_path) is True


def test_an_index_newer_than_every_dependency_file_is_kept(tmp_path):
    (tmp_path / "package.json").write_text("{}", encoding="utf-8")
    (tmp_path / "web").mkdir()
    (tmp_path / "web" / "package.json").write_text("{}", encoding="utf-8")
    _age(tmp_path / "package.json", 60)
    _age(tmp_path / "web" / "package.json", 60)
    _write_index(tmp_path, "{}")

    assert should_refresh_project_index(tmp_path) is False


@pytest.mark.parametrize(
    "changed",
    ["package.json", "go.mod", "pom.xml", "api/pyproject.toml", "app/pubspec.yaml"],
)
def test_a_dependency_file_changed_after_the_index_means_a_rebuild(tmp_path, changed):
    index = _write_index(tmp_path, "{}")
    _age(index, 60)
    target = tmp_path / changed
    target.parent.mkdir(exist_ok=True)
    target.write_text("", encoding="utf-8")

    assert should_refresh_project_index(tmp_path) is True


def test_a_python_service_without_package_json_is_still_watched(tmp_path):
    """The service folder's pyproject.toml counts even when it has no package.json."""
    index = _write_index(tmp_path, "{}")
    _age(index, 60)
    (tmp_path / "api").mkdir()
    (tmp_path / "api" / "pyproject.toml").write_text("", encoding="utf-8")

    assert should_refresh_project_index(tmp_path) is True


@pytest.mark.parametrize(
    "folder", ["node_modules", "dist", "build", ".cache", "__pycache__"]
)
def test_tool_and_hidden_folders_are_not_services(tmp_path, folder):
    index = _write_index(tmp_path, "{}")
    _age(index, 60)
    (tmp_path / folder).mkdir(exist_ok=True)
    (tmp_path / folder / "package.json").write_text("{}", encoding="utf-8")
    (tmp_path / "README.md").write_text("a file, not a service", encoding="utf-8")

    assert should_refresh_project_index(tmp_path) is False


def test_an_index_that_cannot_be_inspected_is_rebuilt(tmp_path, monkeypatch):
    _write_index(tmp_path, "{}")
    real_stat = Path.stat

    def stat(self, *args, **kwargs):
        if self.name == "project_index.json":
            raise PermissionError("denied")
        return real_stat(self, *args, **kwargs)

    monkeypatch.setattr(Path, "stat", stat)

    assert should_refresh_project_index(tmp_path) is True


def test_a_project_folder_that_cannot_be_listed_is_judged_on_its_root_files(
    tmp_path, monkeypatch
):
    index = _write_index(tmp_path, "{}")
    _age(index, 60)
    (tmp_path / "Cargo.toml").write_text("", encoding="utf-8")

    def refuse(self):
        raise PermissionError("denied")

    monkeypatch.setattr(Path, "iterdir", refuse)

    assert should_refresh_project_index(tmp_path) is True
    (tmp_path / "Cargo.toml").unlink()
    assert should_refresh_project_index(tmp_path) is False

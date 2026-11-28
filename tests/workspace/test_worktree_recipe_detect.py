"""Worktree recipe detection beyond the root: sub-folder projects and every stack.

A monorepo keeps its front end in `apps/web` and its API in `src/Api`; each
gets a command run from the worktree root that names its folder. A folder
under a project of the same stack is a member of it and gets none.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from core.workspace import recipe_detect
from core.workspace.recipe import MAX_COMMANDS, detect_recipe, parse_recipe
from core.workspace.recipe_api import render_toml


def _files(root: Path, files: dict[str, str]) -> None:
    for name, content in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")


def _steps(root: Path) -> list[tuple[str, ...]]:
    return list(detect_recipe(root).setup)


@pytest.fixture(autouse=True)
def _posix(monkeypatch):
    monkeypatch.setattr(recipe_detect, "is_windows", lambda: False)


@pytest.mark.parametrize(
    ("files", "expected"),
    [
        (
            {"apps/web/package.json": "{}", "apps/web/pnpm-lock.yaml": ""},
            [("pnpm", "--dir", "apps/web", "install", "--frozen-lockfile")],
        ),
        (
            {"front/package.json": "{}", "front/yarn.lock": ""},
            [("yarn", "--cwd", "front", "install")],
        ),
        (
            {"front/package.json": "{}", "front/bun.lock": ""},
            [("bun", "install", "--cwd", "front")],
        ),
        (
            {"client/package.json": "{}", "client/package-lock.json": "{}"},
            [("npm", "ci", "--prefix", "client")],
        ),
        ({"client/package.json": "{}"}, [("npm", "install", "--prefix", "client")]),
        ({"api/uv.lock": ""}, [("uv", "--directory", "api", "sync")]),
        ({"api/poetry.lock": ""}, [("poetry", "-C", "api", "install")]),
        (
            {"api/requirements.txt": "flask\n"},
            [
                ("python", "-m", "venv", "api/.venv"),
                (
                    "api/.venv/bin/python",
                    "-m",
                    "pip",
                    "install",
                    "-r",
                    "api/requirements.txt",
                ),
            ],
        ),
        (
            {"src/App.sln": "", "src/Api/Api.csproj": "<Project/>"},
            [("dotnet", "restore", "src/App.sln")],
        ),
        ({"svc/go.mod": "module x"}, [("go", "mod", "download", "-C", "svc")]),
        (
            {"engine/Cargo.toml": ""},
            [("cargo", "fetch", "--manifest-path", "engine/Cargo.toml")],
        ),
        (
            {"site/composer.json": "{}"},
            [("composer", "install", "--no-interaction", "--working-dir=site")],
        ),
        ({"web/Gemfile": ""}, [("bundle", "install", "--gemfile=web/Gemfile")]),
        (
            {"mobile/pubspec.yaml": "dependencies:\n  flutter:\n    sdk: flutter\n"},
            [("flutter", "pub", "get", "--directory=mobile")],
        ),
        (
            {"android/gradlew": "", "android/build.gradle": ""},
            [("android/gradlew", "-p", "android", "dependencies", "--quiet")],
        ),
        (
            {"backend/build.gradle.kts": ""},
            [("gradle", "-p", "backend", "dependencies", "--quiet")],
        ),
        (
            {"backend/pom.xml": "<project/>"},
            [("mvn", "-q", "-f", "backend/pom.xml", "dependency:go-offline")],
        ),
        (
            {"ios/Package.swift": ""},
            [("swift", "package", "--package-path", "ios", "resolve")],
        ),
        (
            {"native/vcpkg.json": "{}"},
            [("vcpkg", "install", "--x-manifest-root=native")],
        ),
        (
            {"native/conanfile.txt": ""},
            [
                ("conan", "profile", "detect", "--exist-ok"),
                ("conan", "install", "native", "--build=missing"),
            ],
        ),
    ],
)
def test_a_project_in_a_sub_folder_is_named_by_its_tool(tmp_path, files, expected):
    _files(tmp_path, files)
    assert _steps(tmp_path) == expected


@pytest.mark.parametrize(
    ("files", "expected"),
    [
        ({"build.gradle": ""}, [("gradle", "dependencies", "--quiet")]),
        ({"settings.gradle.kts": ""}, [("gradle", "dependencies", "--quiet")]),
        ({"build.sbt": ""}, [("sbt", "update")]),
        ({"mix.exs": ""}, [("mix", "deps.get")]),
        ({"Package.swift": ""}, [("swift", "package", "resolve")]),
        ({"deno.json": "{}"}, [("deno", "install")]),
        ({"vcpkg.json": "{}"}, [("vcpkg", "install")]),
        (
            {"conanfile.py": ""},
            [
                ("conan", "profile", "detect", "--exist-ok"),
                ("conan", "install", ".", "--build=missing"),
            ],
        ),
        ({"Api.fsproj": "<Project/>"}, [("dotnet", "restore")]),
    ],
)
def test_the_added_stacks_at_the_root(tmp_path, files, expected):
    _files(tmp_path, files)
    assert _steps(tmp_path) == expected


def test_a_monorepo_gets_one_command_per_project(tmp_path):
    _files(
        tmp_path,
        {
            "src/Shop.slnx": "",
            "src/Shop.Api/Shop.Api.csproj": "<Project/>",
            "apps/web/package.json": "{}",
            "apps/web/package-lock.json": "{}",
            "tools/scripts/requirements.txt": "requests\n",
        },
    )
    assert _steps(tmp_path) == [
        ("npm", "ci", "--prefix", "apps/web"),
        ("python", "-m", "venv", "tools/scripts/.venv"),
        (
            "tools/scripts/.venv/bin/python",
            "-m",
            "pip",
            "install",
            "-r",
            "tools/scripts/requirements.txt",
        ),
        ("dotnet", "restore", "src/Shop.slnx"),
    ]


def test_workspace_members_get_no_command_of_their_own(tmp_path):
    _files(
        tmp_path,
        {
            "package.json": "{}",
            "pnpm-lock.yaml": "",
            "packages/ui/package.json": "{}",
            "Cargo.toml": "[workspace]",
            "crates/core/Cargo.toml": "",
            "pom.xml": "<project/>",
            "module-a/pom.xml": "<project/>",
        },
    )
    assert _steps(tmp_path) == [
        ("pnpm", "install", "--frozen-lockfile"),
        ("cargo", "fetch"),
        ("mvn", "-q", "dependency:go-offline"),
    ]


def test_a_sub_project_with_its_own_lockfile_is_its_own(tmp_path):
    # Root package.json for repository tooling, the front end locked apart.
    _files(
        tmp_path,
        {
            "package.json": "{}",
            "frontend/package.json": "{}",
            "frontend/yarn.lock": "",
        },
    )
    assert _steps(tmp_path) == [
        ("npm", "install"),
        ("yarn", "--cwd", "frontend", "install"),
    ]


def test_installed_and_generated_folders_are_not_read(tmp_path):
    _files(
        tmp_path,
        {
            "node_modules/left-pad/package.json": "{}",
            "vendor/lib/composer.json": "{}",
            ".venv/lib/requirements.txt": "",
            "bin/Debug/App.csproj": "",
            ".hidden/go.mod": "module x",
            "docs/requirements.txt": "sphinx\n",
        },
    )
    recipe = detect_recipe(tmp_path)
    assert recipe.setup == ()
    assert recipe.notes


def test_folders_deeper_than_the_limit_are_not_read(tmp_path):
    _files(tmp_path, {"a/b/c/package.json": "{}", "a/b/c/d/go.mod": "module x"})
    assert _steps(tmp_path) == [("npm", "install", "--prefix", "a/b/c")]


def test_a_dotnet_solution_beats_its_projects_and_slnx_beats_sln(tmp_path):
    _files(
        tmp_path,
        {
            "App.sln": "",
            "App.slnx": "",
            "src/Api/Api.csproj": "<Project/>",
            "src/Web/Web.csproj": "<Project/>",
        },
    )
    assert _steps(tmp_path) == [("dotnet", "restore")]


def test_two_solutions_at_the_root_are_each_restored(tmp_path):
    # `dotnet restore` alone stops on MSB1011 with two solutions in the folder.
    _files(tmp_path, {"Back.sln": "", "Front.sln": ""})
    assert _steps(tmp_path) == [
        ("dotnet", "restore", "Back.sln"),
        ("dotnet", "restore", "Front.sln"),
    ]


def test_dotnet_projects_without_a_solution_are_each_restored(tmp_path):
    _files(
        tmp_path,
        {"src/Api/Api.csproj": "<Project/>", "tests/Api.Tests/Api.Tests.csproj": ""},
    )
    assert _steps(tmp_path) == [
        ("dotnet", "restore", "src/Api/Api.csproj"),
        ("dotnet", "restore", "tests/Api.Tests/Api.Tests.csproj"),
    ]


def test_a_tool_manifest_next_to_a_nested_solution_is_named(tmp_path):
    _files(
        tmp_path,
        {"backend/Api.sln": "", "backend/.config/dotnet-tools.json": "{}"},
    )
    assert _steps(tmp_path) == [
        ("dotnet", "restore", "backend/Api.sln"),
        (
            "dotnet",
            "tool",
            "restore",
            "--tool-manifest",
            "backend/.config/dotnet-tools.json",
        ),
    ]


def test_go_modules_each_download_unless_a_workspace_covers_them(tmp_path):
    _files(tmp_path, {"svc/a/go.mod": "module a", "svc/b/go.mod": "module b"})
    assert _steps(tmp_path) == [
        ("go", "mod", "download", "-C", "svc/a"),
        ("go", "mod", "download", "-C", "svc/b"),
    ]
    _files(tmp_path, {"go.work": "go 1.22"})
    assert _steps(tmp_path) == [("go", "mod", "download")]


@pytest.mark.parametrize(
    ("files", "label"),
    [
        ({"umbrella/mix.exs": ""}, "Elixir"),
        ({"scala/build.sbt": ""}, "sbt"),
        ({"edge/deno.json": "{}"}, "Deno"),
    ],
)
def test_a_tool_that_cannot_run_in_a_sub_folder_says_so(tmp_path, files, label):
    _files(tmp_path, files)
    recipe = detect_recipe(tmp_path)
    assert recipe.setup == ()
    assert any(label in note for note in recipe.notes)


def test_a_deno_root_is_not_also_an_npm_project(tmp_path):
    _files(tmp_path, {"deno.json": "{}", "package.json": "{}"})
    assert _steps(tmp_path) == [("deno", "install")]


def test_windows_names_the_sub_folder_venv_python(tmp_path, monkeypatch):
    monkeypatch.setattr(recipe_detect, "is_windows", lambda: True)
    _files(tmp_path, {"api/requirements.txt": "", "android/gradlew.bat": ""})
    steps = _steps(tmp_path)
    assert steps[1][0] == "api\\.venv\\Scripts\\python.exe"
    assert steps[2][0] == "android/gradlew.bat"


def test_too_many_commands_are_cut_with_a_note(tmp_path):
    _files(
        tmp_path, {f"svc/m{i:02}/go.mod": "module m" for i in range(MAX_COMMANDS + 3)}
    )
    recipe = detect_recipe(tmp_path)
    assert len(recipe.setup) == MAX_COMMANDS
    assert any("first" in note for note in recipe.notes)


def test_the_detected_recipe_saves_as_a_valid_file(tmp_path):
    _files(
        tmp_path,
        {
            "src/Shop.sln": "",
            "apps/web/package.json": "{}",
            "apps/web/pnpm-lock.yaml": "",
            "native/vcpkg.json": "{}",
        },
    )
    detected = detect_recipe(tmp_path)
    saved = parse_recipe(render_toml(detected.setup))
    assert saved.errors == ()
    assert saved.setup == detected.setup


def test_an_unreadable_folder_is_skipped(tmp_path, monkeypatch):
    _files(tmp_path, {"package.json": "{}", "locked/go.mod": "module x"})
    real = recipe_detect.os.scandir

    def scandir(path):
        if Path(path).name == "locked":
            raise PermissionError("denied")
        return real(path)

    monkeypatch.setattr(recipe_detect.os, "scandir", scandir)
    assert _steps(tmp_path) == [("npm", "install")]


class _Entry:
    """A directory entry the platform may not let a test create (link, pipe)."""

    def __init__(self, name: str, *, link: bool = False) -> None:
        self.name = name
        self.link = link

    def is_symlink(self) -> bool:
        if self.name == "broken":
            raise OSError("gone")
        return self.link

    def is_file(self) -> bool:
        return False

    def is_dir(self) -> bool:
        return False


def test_links_special_and_unreadable_entries_are_skipped(tmp_path, monkeypatch):
    _files(tmp_path, {"package.json": "{}"})
    real = recipe_detect.os.scandir
    extra = [
        _Entry("go.mod", link=True),  # a link to a file outside the project
        _Entry("Cargo.toml"),  # a pipe or a socket
        _Entry("broken"),
    ]

    def scandir(path):
        return [*real(path), *extra]

    monkeypatch.setattr(recipe_detect.os, "scandir", scandir)
    assert _steps(tmp_path) == [("npm", "install")]


def test_an_unreadable_pubspec_is_a_dart_project(tmp_path, monkeypatch):
    _files(tmp_path, {"pubspec.yaml": "dependencies:\n  flutter:\n"})

    def read_text(self, *args, **kwargs):
        raise PermissionError("denied")

    monkeypatch.setattr(recipe_detect.Path, "read_text", read_text)
    assert _steps(tmp_path) == [("dart", "pub", "get")]

"""What `libdocs` reads from each ecosystem's manifests, and how it counts usage.

One test per manifest a real project of that stack has; usage is counted in a
real git repository and, without git, by walking the files.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest
from libdocs import detect
from libdocs.detect import Dependency, detect_needs, read_manifests, usage_counts


def _write(root: Path, files: dict[str, str]) -> Path:
    for name, text in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    return root


def _versions(project: Path) -> dict[str, tuple[str, str]]:
    return {n: (d.ecosystem, d.version) for n, d in read_manifests(project).items()}


def _git(project: Path) -> None:
    for args in (
        ["init", "-q"],
        ["add", "-A"],
        ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "x"],
    ):
        subprocess.run(["git", *args], cwd=project, check=True, capture_output=True)


# --- manifests ----------------------------------------------------------------------


def test_a_dotnet_project_declares_its_nuget_packages(tmp_path):
    _write(
        tmp_path,
        {
            "src/Shop.Api/Shop.Api.csproj": (
                '<Project Sdk="Microsoft.NET.Sdk.Web">\n  <ItemGroup>\n'
                '    <PackageReference Include="Serilog.AspNetCore" Version="9.0.0" />\n'
                "    <PackageReference Version='13.0.3' Include='Newtonsoft.Json'/>\n"
                '    <PackageReference Include="Polly">\n'
                "      <Version>8.5.0</Version>\n    </PackageReference>\n"
                '    <ProjectReference Include="..\\Shop.Core\\Shop.Core.csproj" />\n'
                "  </ItemGroup>\n</Project>\n"
            ),
            "Directory.Packages.props": (
                '<Project><ItemGroup><PackageVersion Include="MediatR" Version="12.4.1" />'
                "</ItemGroup></Project>"
            ),
            "legacy/packages.config": (
                '<packages><package id="Dapper" version="2.1.35" /></packages>'
            ),
            "fsharp/App.fsproj": '<Project><PackageReference Include="FSharp.Data" /></Project>',
        },
    )

    assert _versions(tmp_path) == {
        "Serilog.AspNetCore": ("nuget", "9.0.0"),
        "Newtonsoft.Json": ("nuget", "13.0.3"),
        "Polly": ("nuget", ""),
        "MediatR": ("nuget", "12.4.1"),
        "Dapper": ("nuget", "2.1.35"),
        "FSharp.Data": ("nuget", ""),
    }


def test_a_pom_names_only_its_dependencies(tmp_path):
    _write(
        tmp_path,
        {
            "pom.xml": (
                "<project><artifactId>shop</artifactId>"
                "<parent><artifactId>spring-boot-starter-parent</artifactId></parent>"
                "<dependencies><dependency><groupId>org.springframework.boot</groupId>"
                "<artifactId>spring-boot-starter-web</artifactId></dependency>"
                "<dependency><artifactId>jackson-databind</artifactId>"
                "<version>2.18.0</version></dependency></dependencies>"
                "<build><plugins><plugin><artifactId>maven-surefire-plugin</artifactId>"
                "</plugin></plugins></build></project>"
            )
        },
    )

    assert _versions(tmp_path) == {
        "spring-boot-starter-web": ("maven", ""),
        "jackson-databind": ("maven", "2.18.0"),
    }


def test_gradle_go_cargo_composer_gemfile_and_pubspec(tmp_path):
    _write(
        tmp_path,
        {
            "android/build.gradle.kts": 'implementation("com.squareup.okhttp3:okhttp:4.12.0")\n',
            "svc/go.mod": (
                "module shop\n\ngo 1.23\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.10.0\n"
                "\tgolang.org/x/text v0.21.0 // indirect\n)\n"
                "require github.com/redis/go-redis/v9 v9.7.0\n"
            ),
            "core/Cargo.toml": (
                '[dependencies]\nserde = "1"\ntokio = { version = "1", features = ["full"] }\n'
                '[dev-dependencies]\ninsta = "1.41"\n'
            ),
            "web/composer.json": json.dumps(
                {"require": {"php": ">=8.2", "laravel/framework": "^11.0"}}
            ),
            "ruby/Gemfile": "source 'https://rubygems.org'\ngem 'rails', '~> 8.0'\n",
            "mobile/pubspec.yaml": (
                "name: shop\ndependencies:\n  flutter:\n    sdk: flutter\n"
                "  http: ^1.2.2\nflutter:\n  uses-material-design: true\n"
            ),
        },
    )

    found = _versions(tmp_path)

    assert found["okhttp"] == ("maven", "4.12.0")
    assert found["github.com/gin-gonic/gin"] == ("go", "v1.10.0")
    assert found["golang.org/x/text"] == ("go", "v0.21.0")
    assert found["github.com/redis/go-redis/v9"] == ("go", "v9.7.0")
    assert found["serde"] == ("cargo", "1")
    assert found["tokio"] == ("cargo", "")
    assert found["insta"] == ("cargo", "1.41")
    assert found["laravel/framework"] == ("composer", "^11.0")
    assert "php" not in found
    assert found["rails"] == ("gem", "")
    assert found["http"] == ("pub", "1.2.2")
    assert "uses-material-design" not in found


def test_python_manifests_in_their_three_shapes(tmp_path):
    _write(
        tmp_path,
        {
            "pyproject.toml": (
                '[project]\ndependencies = ["httpx>=0.28", "pydantic[email]==2.10"]\n'
                '[project.optional-dependencies]\ndev = ["pytest"]\nbad = "ruff"\n'
                '[tool.poetry.dependencies]\npython = "^3.12"\nrich = "^13"\n'
                'typer = { version = "^0.15" }\n'
            ),
            "requirements.txt": "# pinned\n-r base.txt\nfastapi==0.115  # web\n\n",
            "Pipfile": "requests>=2.32\n",
        },
    )

    found = _versions(tmp_path)

    assert found["httpx"] == ("pypi", ">=0.28")
    assert found["pydantic"] == ("pypi", "==2.10")
    assert found["pytest"] == ("pypi", "")
    assert found["rich"] == ("pypi", "^13")
    assert found["typer"] == ("pypi", "")
    assert found["fastapi"] == ("pypi", "==0.115")
    assert found["requests"] == ("pypi", ">=2.32")
    assert "python" not in found and "ruff" not in found


@pytest.mark.parametrize(
    "pyproject",
    [
        'dependencies = "flask"\n[project\n',  # not TOML: read as requirement lines
        '[project]\ndependencies = "flask"\n[tool]\npoetry = 3\n',
    ],
)
def test_an_odd_pyproject_gives_no_garbage_names(tmp_path, pyproject):
    _write(tmp_path, {"pyproject.toml": pyproject})

    assert not {"f", "l", "a", "s", "k"} & set(read_manifests(tmp_path))


@pytest.mark.parametrize("content", ["[1, 2]", '"text"', "{broken"])
def test_a_json_manifest_that_is_not_an_object_declares_nothing(tmp_path, content):
    _write(tmp_path, {"package.json": content, "composer.json": content})

    assert read_manifests(tmp_path) == {}


def test_a_manifest_that_cannot_be_read_is_skipped(tmp_path, monkeypatch):
    _write(tmp_path, {"package.json": '{"dependencies": {"zod": "3"}}', "go.mod": ""})

    def refuse(path, *_args, **_kwargs):
        raise PermissionError(path)

    real = Path.read_text
    monkeypatch.setattr(
        Path,
        "read_text",
        lambda self, *a, **k: (
            refuse(self) if self.name == "go.mod" else real(self, *a, **k)
        ),
    )

    assert set(read_manifests(tmp_path)) == {"zod"}


def test_the_scan_stops_at_its_depth_and_skips_tool_folders(tmp_path):
    _write(
        tmp_path,
        {
            "a/b/c/package.json": '{"dependencies": {"deep-but-read": "1"}}',
            "a/b/c/d/package.json": '{"dependencies": {"too-deep": "1"}}',
            "node_modules/x/package.json": '{"dependencies": {"vendored": "1"}}',
            ".hidden/package.json": '{"dependencies": {"hidden": "1"}}',
        },
    )

    assert set(read_manifests(tmp_path)) == {"deep-but-read"}


def test_the_number_of_manifests_read_is_bounded(tmp_path):
    for i in range(30):
        _write(
            tmp_path,
            {
                f"pkg{i:02}/package.json": json.dumps(
                    {"dependencies": {f"d{i:02}": "1"}}
                )
            },
        )

    assert len(read_manifests(tmp_path)) == 24


def test_an_unlistable_folder_is_skipped(tmp_path, monkeypatch):
    _write(
        tmp_path, {"package.json": '{"dependencies": {"zod": "3"}}', "sub/go.mod": ""}
    )
    real = Path.iterdir

    def iterdir(self):
        if self.name == "sub":
            raise PermissionError(self)
        return real(self)

    monkeypatch.setattr(Path, "iterdir", iterdir)

    assert set(read_manifests(tmp_path)) == {"zod"}


def test_short_names_follow_how_prose_writes_them():
    assert Dependency("@tanstack/react-query", "npm").short_name == "react-query"
    assert Dependency("github.com/gin-gonic/gin", "go").short_name == "gin"
    assert Dependency("Polly", "nuget").short_name == "Polly"


def test_a_need_explains_itself():
    need = detect.LibraryNeed("zod", reasons=("named-by-task", "unused-in-repo"))

    assert need.describe() == "zod (named-by-task, unused-in-repo)"
    assert detect.LibraryNeed("x").describe() == "x (no reason recorded)"


# --- usage ------------------------------------------------------------------------------


USAGE_PROJECT = {
    "Shop.csproj": '<Project><PackageReference Include="Serilog" Version="4" /></Project>',
    "Program.cs": 'using Serilog;\nLog.Information("up");\n',
    "Report.fs": "open Serilog\n",
    "Legacy.vb": "Imports Serilog\n",
    "go.mod": "require github.com/gin-gonic/gin v1.10.0\n",
    "main.go": 'import "github.com/gin-gonic/gin"\n',
    "App.java": "import okhttp3.OkHttpClient; // okhttp\n",
    "cli.py": "import yaml\nfrom rich import print\n",
}
NAMES = {
    "Serilog": "nuget",
    "github.com/gin-gonic/gin": "go",
    "okhttp": "maven",
    "PyYAML": "pypi",
    "rich": "pypi",
    "absent-lib": "npm",
}
EXPECTED = {
    "Serilog": 3,
    "github.com/gin-gonic/gin": 1,
    "okhttp": 1,
    "PyYAML": 1,
    "rich": 1,
    "absent-lib": 0,
}


def test_usage_is_counted_per_ecosystem_in_a_repository(tmp_path):
    _write(tmp_path, USAGE_PROJECT)
    _git(tmp_path)

    assert usage_counts(tmp_path, NAMES) == EXPECTED


def test_usage_is_counted_the_same_without_git(tmp_path):
    _write(tmp_path, USAGE_PROJECT)

    assert usage_counts(tmp_path, NAMES) == EXPECTED


def test_no_name_no_count(tmp_path):
    assert usage_counts(tmp_path, {}) == {}


def test_without_a_git_executable_the_walk_answers(tmp_path, monkeypatch):
    _write(tmp_path, {"a.ts": 'import z from "zod"\n'})

    def no_git(*_args, **_kwargs):
        raise FileNotFoundError("git")

    monkeypatch.setattr(detect.subprocess, "run", no_git)

    assert usage_counts(tmp_path, {"zod": "npm"}) == {"zod": 1}
    assert detect._source_file_count(tmp_path) == 1


def test_the_walk_reads_a_bounded_number_of_files(tmp_path, monkeypatch):
    monkeypatch.setattr(detect, "_MAX_FALLBACK_FILES", 2)
    _write(tmp_path, {f"f{i}.ts": 'import z from "zod"\n' for i in range(5)})

    assert usage_counts(tmp_path, {"zod": "npm"}) == {"zod": 2}


def test_the_walk_skips_what_it_cannot_read_or_list(tmp_path, monkeypatch):
    _write(
        tmp_path,
        {
            "a.ts": 'import z from "zod"\n',
            "locked/b.ts": 'import z from "zod"\n',
            "c.ts": "zod",
        },
    )
    real_read, real_iterdir = Path.read_text, Path.iterdir

    def read_text(self, *args, **kwargs):
        if self.name == "c.ts":
            raise PermissionError(self)
        return real_read(self, *args, **kwargs)

    def iterdir(self):
        if self.name == "locked":
            raise PermissionError(self)
        return real_iterdir(self)

    monkeypatch.setattr(Path, "read_text", read_text)
    monkeypatch.setattr(Path, "iterdir", iterdir)

    assert detect._walk_counts(tmp_path, {"zod": "npm"}) == {"zod": 1}


def test_the_source_count_stops_at_its_cap(tmp_path):
    _write(tmp_path, {f"f{i}.py": "" for i in range(6)})

    assert detect._source_file_count(tmp_path, cap=4) == 4  # walk (not a repository)
    _git(tmp_path)
    assert detect._source_file_count(tmp_path, cap=4) == 4  # git ls-files


# --- the decision -----------------------------------------------------------------------


def test_a_dotnet_task_gets_the_docs_of_the_package_it_names_and_does_not_use_yet(
    tmp_path,
):
    _write(
        tmp_path,
        {
            "Shop.csproj": (
                '<Project><PackageReference Include="Polly" Version="8.5.0" />'
                '<PackageReference Include="Serilog" Version="4.0.0" /></Project>'
            ),
            **{f"F{i}.cs": "using Serilog;\n" for i in range(4)},
        },
    )
    _git(tmp_path)

    needs = detect_needs(tmp_path, "Add a Polly retry policy and log it with Serilog")

    assert [(n.name, n.ecosystem, n.version, n.reasons) for n in needs] == [
        ("Polly", "nuget", "8.5.0", ("named-by-task", "unused-in-repo"))
    ]


def test_a_negative_budget_downloads_nothing(tmp_path):
    _write(tmp_path, {"package.json": '{"dependencies": {"zod": "3"}}'})

    assert detect_needs(tmp_path, "use zod", limit=-1) == []


def test_without_declared_dependencies_the_fallback_has_nothing_to_offer(tmp_path):
    assert detect_needs(tmp_path, "refactor the cart") == []


def test_odd_entries_of_go_cargo_toml_and_nuget_files_are_not_dependencies(tmp_path):
    _write(
        tmp_path,
        {
            "go.mod": "module shop\ntoolchain go1.23.4\nrequire golang.org/x/sync v0.10.0\n",
            "a/Cargo.toml": "dependencies = 3\n[dev-dependencies]\ninsta = '1'\n",
            "b/pyproject.toml": "project = 3\n",
            "App.csproj": '<Project><PackageReference Update="Serilog" Version="4" /></Project>',
        },
    )

    assert set(read_manifests(tmp_path)) == {"golang.org/x/sync", "insta"}


def test_manifest_labels_are_posix_paths(tmp_path):
    _write(tmp_path, {"apps/web/package.json": '{"dependencies": {"zod": "3"}}'})

    assert read_manifests(tmp_path)["zod"].manifest == "apps/web/package.json"


def test_a_task_naming_new_libraries_in_prose(tmp_path):
    declared, undeclared = detect.mentioned_libraries(
        "Render with `htmx`, query with @tanstack/query, skip `@nope`, `9lives` and "
        "`src/app.ts`; `zod` is already there, @tanstack/react-query too.",
        {
            "zod": Dependency("zod", "npm"),
            "@tanstack/react-query": Dependency("@tanstack/react-query", "npm"),
        },
    )

    assert declared == {"zod"}
    assert undeclared == {"htmx", "@tanstack/query"}


def test_the_repository_file_count_ignores_files_that_are_not_source(tmp_path):
    _write(tmp_path, {"README.md": "", "a.py": "", "b.py": "", "logo.svg": ""})
    _git(tmp_path)

    assert detect._source_file_count(tmp_path) == 2

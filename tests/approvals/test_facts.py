"""Facts of a pull request: type, bump, areas, layers, git change set."""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest
from approvals.facts import (
    build_facts,
    bump_level,
    changed_files,
    clean_layers_touched,
    code_areas,
    is_dependency_file,
    title_type,
)
from approvals.model import ChangedFile


@pytest.mark.parametrize(
    ("title", "kind", "expected"),
    [
        ("feat(api): add orders", None, ("feat", False)),
        ("feat(api)!: drop v1", None, ("feat", True)),
        ("fix: null check", None, ("fix", False)),
        ("chore(deps): bump vite from 7.1.2 to 7.2.0", None, ("deps", False)),
        ("build(deps-dev): bump pytest", None, ("deps", False)),
        ("Bump Newtonsoft.Json from 12.0.3 to 13.0.1 in /src", None, ("deps", False)),
        ("Update dependency react to v19", None, ("deps", False)),
        ("docs: README", None, ("docs", False)),
        ("refactor: BREAKING CHANGE in config", None, ("refactor", True)),
        ("Add a login page", "feature", ("feat", False)),
        ("Something", "bug_fix", ("fix", False)),
        ("Something", None, ("other", False)),
        ("weird(scope): text", None, ("other", False)),
    ],
)
def test_title_type(title, kind, expected):
    assert title_type(title, kind) == expected


@pytest.mark.parametrize(
    ("title", "level"),
    [
        ("chore(deps): bump vite from 7.1.2 to 7.2.0", "minor"),
        ("chore(deps): bump vite from 7.1.2 to 7.1.3", "patch"),
        ("chore(deps): bump vite from 7.1.2 to 8.0.0", "major"),
        ("Bump x from v1.2.0 to v2.0.0", "major"),
        ("Bump x from 0.3.1 to 0.4.0", "major"),
        ("Bump x from 0.3.1 to 0.3.2", "patch"),
        ("Bump x from 3 to 3", "unknown"),
        ("Update dependency react to v19", "major"),
        ("chore(deps): bump the npm group", "unknown"),
    ],
)
def test_bump_level(title, level):
    assert bump_level(title) == level


@pytest.mark.parametrize(
    ("path", "expected"),
    [
        ("package.json", True),
        ("apps/frontend/pnpm-lock.yaml", True),
        ("src/Shop.Api/Shop.Api.csproj", True),
        ("Directory.Packages.props", True),
        ("requirements-dev.txt", True),
        ("go.sum", True),
        ("Cargo.lock", True),
        ("src/app.py", False),
        ("README.md", False),
    ],
)
def test_dependency_files_of_every_stack(path, expected):
    assert is_dependency_file(path) is expected


def test_code_areas_skip_text_tests_and_ci():
    paths = [
        "apps/backend/x.py",
        "apps/backend/y/z.py",
        "apps/frontend/src/a.ts",
        "tests/test_x.py",
        "docs/a.md",
        "README.md",
        ".github/workflows/ci.yml",
        "lib/util.go",
        "pytest.ini",
    ]
    assert code_areas(paths) == (".", "apps/backend", "apps/frontend", "lib")


def test_build_facts_counts_layers_and_the_areas_outside_them():
    files = [
        ChangedFile("src/Shop.Domain/Order.cs", 5, 1),
        ChangedFile("src/Shop.Api/OrdersController.cs", 3, 0),
        ChangedFile("tools/gen.py", 1, 0),
    ]
    facts = build_facts(
        files,
        title="fix: order total",
        layers={
            "src/Shop.Domain/Order.cs": "domain",
            "src/Shop.Api/OrdersController.cs": "presentation",
        },
    )
    assert facts.layers == ("domain", "presentation", "tools")
    assert facts.layer_source == "mixed"
    only_layers = build_facts(
        files[:2],
        title="fix: x",
        layers={
            "src/Shop.Domain/Order.cs": "domain",
            "src/Shop.Api/OrdersController.cs": "presentation",
        },
    )
    assert only_layers.layer_source == "layers"


def test_build_facts_reads_a_bump_and_docs_and_bounds_inputs():
    bump = build_facts(
        [ChangedFile("package.json", 1, 1), ChangedFile("pnpm-lock.yaml", 9, 9)],
        title="Bump vite from 7.1.2 to 7.1.4",
    )
    assert (bump.type, bump.bump) == ("deps", "patch")
    docs = build_facts([ChangedFile("docs/a.md", 3, 0)], title="Update the guide")
    assert docs.type == "docs"
    odd = build_facts([ChangedFile("a.py")], ci="purple", review="maybe", trust=400)
    assert (odd.ci, odd.review, odd.trust) == ("unknown", "none", None)


def _git(cwd: Path, *args: str) -> None:
    subprocess.run(
        ["git", "-c", "user.name=t", "-c", "user.email=t@example.com", *args],
        cwd=cwd,
        check=True,
        capture_output=True,
    )


def test_changed_files_reads_the_committed_change_set(tmp_path):
    _git(tmp_path, "init", "-q", "-b", "main")
    (tmp_path / "a.py").write_text("x = 1\n", encoding="utf-8")
    _git(tmp_path, "add", ".")
    _git(tmp_path, "commit", "-qm", "base")
    _git(tmp_path, "checkout", "-qb", "work")
    (tmp_path / "a.py").write_text("x = 2\ny = 3\n", encoding="utf-8")
    (tmp_path / "b.bin").write_bytes(b"\x00\x01")
    _git(tmp_path, "add", ".")
    _git(tmp_path, "commit", "-qm", "change")
    files = {f.path: f for f in changed_files(tmp_path, "main")}
    assert files["a.py"].added == 2 and files["a.py"].deleted == 1
    assert files["b.bin"].binary


@pytest.mark.parametrize("ref", ["--output=x", "a..b", "", "main;rm"])
def test_changed_files_refuses_odd_refs(tmp_path, ref):
    assert changed_files(tmp_path, ref) is None


def test_changed_files_is_none_outside_git(tmp_path):
    assert changed_files(tmp_path, "main") is None


def test_clean_layers_of_a_dotnet_solution(tmp_path):
    for name in ("Shop.Domain", "Shop.Application", "Shop.Api"):
        folder = tmp_path / "src" / name
        folder.mkdir(parents=True)
        (folder / f"{name}.csproj").write_text("<Project />", encoding="utf-8")
    placed = clean_layers_touched(
        tmp_path, ["src/Shop.Domain/Order.cs", "src/Shop.Api/Program.cs", "tools/x.py"]
    )
    assert placed == {
        "src/Shop.Domain/Order.cs": "domain",
        "src/Shop.Api/Program.cs": "presentation",
    }
    assert clean_layers_touched(tmp_path / "src" / "Shop.Api", ["x.cs"]) is None

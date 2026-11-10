"""The code's story: hot spots, decisions, chapters, roles and freshness (#349).

Every stack is read the same way: the hot spots come from git and the source,
the decisions from ADR files, breaking commits and the project's memory, and
the tour for a role keeps the areas that role works in.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

_ROOT = Path(__file__).resolve().parents[2]
_BACKEND = _ROOT / "apps" / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from onboarding_agent import OnboardingPackageBuilder  # noqa: E402
from onboarding_agent.decisions import _adr, adr_files, read_decisions  # noqa: E402
from onboarding_agent.hotspots import (  # noqa: E402
    analyse_hotspots,
    complexity_of,
    danger_of,
    git_churn,
)
from onboarding_agent.narrate import clean_paragraph, narrate  # noqa: E402
from onboarding_agent.story import (  # noqa: E402
    area_of,
    fingerprint,
    freshness,
    role_tours,
    save_fingerprint,
)
from onboarding_agent.tour_builder import TourStep, render_markdown  # noqa: E402


def _write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def _git(root: Path, *args: str, author: str = "ana") -> None:
    env = {
        **os.environ,
        "GIT_AUTHOR_NAME": author,
        "GIT_AUTHOR_EMAIL": f"{author}@example.com",
        "GIT_COMMITTER_NAME": author,
        "GIT_COMMITTER_EMAIL": f"{author}@example.com",
    }
    subprocess.run(["git", *args], cwd=root, env=env, check=True, capture_output=True)


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    root = tmp_path / "Shop"
    root.mkdir()
    _git(root, "init", "-q", "-b", "main")
    _write(root / "README.md", "# Shop\n")
    _write(root / "src" / "Api" / "Program.cs", "app.Run();\n")
    _write(root / "src" / "Api" / "OrdersController.cs", "class C { }\n")
    _write(root / "src" / "Auth" / "TokenService.cs", "class T { }\n")
    _write(root / "src" / "Auth" / "Login.cs", "class L { }\n")
    _write(root / "src" / "Auth" / "Roles.cs", "class R { }\n")
    _write(
        root / "web" / "components" / "Cart.tsx", "export const Cart = () => null;\n"
    )
    _write(
        root / "web" / "components" / "Menu.tsx", "export const Menu = () => null;\n"
    )
    _write(
        root / "web" / "components" / "Footer.tsx",
        "export const Footer = () => null;\n",
    )
    _write(root / "tests" / "OrdersControllerTests.cs", "class T { }\n")
    _write(
        root / "docs" / "adr" / "0001-use-postgres.md",
        "# 1. Use PostgreSQL\n\nDate: 2025-03-02\n\n## Status\n\nAccepted\n",
    )
    _git(root, "add", ".")
    _git(root, "commit", "-q", "-m", "feat: first version")
    for index in range(4):
        author = "ana" if index % 2 else "bob"
        _write(
            root / "src" / "Auth" / "TokenService.cs",
            "class T {\n" + "  void A() { if (x && y) { } }\n" * (index + 2) + "}\n",
        )
        _git(root, "commit", "-qam", f"fix: token check {index}", author=author)
    _write(
        root / "src" / "Api" / "OrdersController.cs",
        "class C { void A() { if (a) {} } }\n",
    )
    _git(root, "commit", "-qam", "refactor(api)!: orders are paged")
    return root


# --- hot spots --------------------------------------------------------------


def test_churn_counts_commits_and_people(repo: Path) -> None:
    churn = git_churn(repo)

    assert churn["src/Auth/TokenService.cs"] == (5, 2)
    assert churn["README.md"] == (1, 1)


def test_churn_is_empty_without_git(tmp_path: Path) -> None:
    assert git_churn(tmp_path) == {}


@pytest.mark.parametrize(
    ("source", "count"),
    [
        ("if (a && b) { } else if (c) { }", 3),
        ("for x in y:\n    if x or z: pass  # if not counted", 2),
        ("match v { Some(x) => 1, _ => 2 }", 1),
        ("try { } catch (Exception e) { } foreach (var a in b) { }", 2),
        ("const a = b ? c : d; const e = f ?? g;", 2),
    ],
)
def test_complexity_counts_decision_points_on_every_stack(
    source: str, count: int
) -> None:
    assert complexity_of(source) == count


@pytest.mark.parametrize(
    ("path", "source", "zones"),
    [
        ("src/Auth/TokenService.cs", "", ["security"]),
        ("app/billing/invoice.rb", "", ["billing"]),
        ("db/migrate/20250101_add_users.rb", "", ["migrations"]),
        ("Migrations/20250101_Init.cs", "", ["migrations"]),
        (".github/workflows/ci.yml", "", ["infrastructure"]),
        ("terraform/main.tf", "", ["infrastructure"]),
        ("lib/util.py", "hashed = bcrypt.hashpw(pw, salt)", ["security"]),
        ("src/checkout.ts", "stripe.paymentIntents.create()", ["billing"]),
        ("src/Shared/Strings.cs", "", []),
    ],
)
def test_danger_zones_by_path_and_by_code(
    path: str, source: str, zones: list[str]
) -> None:
    assert danger_of(path, source) == zones


def test_the_riskiest_file_comes_first_with_its_reasons(repo: Path) -> None:
    files = [
        "src/Api/Program.cs",
        "src/Api/OrdersController.cs",
        "src/Auth/TokenService.cs",
        "tests/OrdersControllerTests.cs",
    ]
    spots = analyse_hotspots(
        repo, files, lambda p: (repo / p).read_text(encoding="utf-8")
    )

    assert spots[0].path == "src/Auth/TokenService.cs"
    assert spots[0].danger == ["security"] and not spots[0].tested
    keys = [reason.key for reason in spots[0].reasons]
    assert keys == [
        "generated.story.reason.churn",
        "generated.story.reason.complexity",
        "generated.story.danger.security",
        "generated.story.reason.untested",
    ]
    controller = next(s for s in spots if s.path == "src/Api/OrdersController.cs")
    assert controller.tested
    assert all(s.path != "tests/OrdersControllerTests.cs" for s in spots)


# --- decisions --------------------------------------------------------------


@pytest.mark.parametrize(
    "path",
    [
        "docs/adr/0001-use-postgres.md",
        "doc/adr/0002-x.md",
        "docs/decisions/0003-y.md",
        "docs/architecture/decisions/0004-z.md",
        "adr/0005-a.md",
        "ADR-006-events.md",
    ],
)
def test_decision_records_are_found_where_teams_keep_them(path: str) -> None:
    assert adr_files([path, "src/adr.ts", "docs/guide.md"]) == [path]


def test_a_madr_record_gives_its_title_status_and_date() -> None:
    record = _adr(
        "docs/decisions/0007-queue.md",
        "---\nstatus: superseded\n---\n# 7. Use a queue for e-mails\n\nDate: 2024-11-02\n",
    )

    assert record is not None
    assert (record.title, record.status, record.date) == (
        "Use a queue for e-mails",
        "superseded",
        "2024-11-02",
    )


def test_the_index_and_template_are_not_decisions() -> None:
    assert _adr("docs/adr/README.md", "# Decisions") is None
    assert _adr("docs/adr/template.md", "# Title") is None


def test_breaking_commits_and_records_are_the_team_s_decisions(repo: Path) -> None:
    files = ["docs/adr/0001-use-postgres.md"]
    decisions = read_decisions(
        repo, files, lambda p: (repo / p).read_text(encoding="utf-8")
    )

    sources = [(d.source, d.title) for d in decisions]
    assert ("adr", "Use PostgreSQL") in sources
    assert ("commit", "refactor(api)!: orders are paged") in sources
    adr = next(d for d in decisions if d.source == "adr")
    assert (adr.status, adr.date) == ("accepted", "2025-03-02")


# --- roles ------------------------------------------------------------------


@pytest.mark.parametrize(
    ("path", "area"),
    [
        ("web/components/Cart.tsx", "ui"),
        ("lib/screens/home.dart", "ui"),
        ("Views/Home/Index.cshtml", "ui"),
        ("src/Api/OrdersController.cs", "api"),
        ("cmd/server/main.go", "api"),
        ("app/models/user.rb", "data"),
        ("Migrations/20250101_Init.cs", "data"),
        (".github/workflows/ci.yml", "infra"),
        ("Dockerfile", "infra"),
        ("tests/test_orders.py", "tests"),
        ("README.md", "docs"),
        ("src/lib.rs", "general"),
    ],
)
def test_every_stack_gets_its_area(path: str, area: str) -> None:
    assert area_of(path) == area


def _step(order: int, path: str, category: str = "file") -> TourStep:
    return TourStep(
        order=order, title=path, file_path=path, reason="", category=category
    )


def test_each_role_keeps_its_areas_and_the_general_steps() -> None:
    tour = [
        _step(1, "README.md", "doc"),
        _step(2, "src/Program.cs", "entrypoint"),
        _step(3, "web/components/Cart.tsx"),
        _step(4, "src/Api/OrdersController.cs"),
        _step(5, ".github/workflows/ci.yml"),
    ]
    roles = role_tours(tour)

    assert roles["fullstack"] == [1, 2, 3, 4, 5]
    assert roles["frontend"] == [1, 2, 3]
    assert roles["backend"] == [1, 2, 4]
    assert roles["devops"] == [1, 2, 5]


def test_a_role_with_nothing_of_its_own_sees_the_whole_tour() -> None:
    tour = [_step(1, "README.md", "doc"), _step(2, "web/components/Cart.tsx")]

    assert role_tours(tour)["devops"] == [1, 2]


# --- the package ------------------------------------------------------------


def _package(repo: Path) -> dict[str, Any]:
    return OnboardingPackageBuilder().build(repo).to_dict()


def test_the_package_tells_five_chapters(repo: Path) -> None:
    story = _package(repo)["story"]

    ids = [chapter["id"] for chapter in story["chapters"]]
    assert ids == ["structure", "entry", "critical", "fragile", "decisions"]
    critical = story["chapters"][2]
    assert critical["files"] == ["src/Auth/TokenService.cs"]
    assert critical["lines"][0]["params"]["churn"] == 5
    decisions = story["chapters"][4]["lines"]
    assert {line["key"] for line in decisions} == {
        "generated.story.line.adr",
        "generated.story.line.breaking",
    }
    assert set(story["roles"]) == {"fullstack", "frontend", "backend", "devops"}


def test_the_quiz_asks_about_the_hot_spots(repo: Path) -> None:
    quiz = _package(repo)["quiz"]
    keys = {q["question_i18n"]["key"] for q in quiz}

    assert "generated.story.quiz.churn.question" in keys
    assert "generated.story.quiz.zone.security" in keys
    churn = next(
        q
        for q in quiz
        if q["question_i18n"]["key"] == "generated.story.quiz.churn.question"
    )
    assert churn["choices"][churn["correct_index"]] == "src/Auth/TokenService.cs"


def test_a_project_without_decisions_says_so(tmp_path: Path) -> None:
    _write(tmp_path / "main.py", "print('hi')\n")
    story = _package(tmp_path)["story"]

    assert story["chapters"][-1]["lines"][0]["key"] == "generated.story.line.noDecision"
    assert story["hotspots"] == [] or all(not h["churn"] for h in story["hotspots"])


def test_the_markdown_tells_the_story_in_english(repo: Path) -> None:
    builder = OnboardingPackageBuilder()
    markdown = render_markdown(builder.build(repo))

    assert "## The Code's Story" in markdown
    assert "| `src/Auth/TokenService.cs` |" in markdown


# --- freshness --------------------------------------------------------------


def test_a_new_module_makes_the_tour_stale(tmp_path: Path) -> None:
    files = ["src/a/x.py", "src/a/y.py", "src/a/z.py", "pyproject.toml"]
    digest, modules, manifests = fingerprint(files, files[:3])
    assert modules == ["src", "src/a"]

    assert freshness(tmp_path, files, files[:3])["known"] is False
    save_fingerprint(tmp_path, digest, modules, manifests)
    assert freshness(tmp_path, files, files[:3])["stale"] is False

    grown = [*files, "src/b/x.py", "src/b/y.py", "src/b/z.py"]
    status = freshness(tmp_path, grown, [f for f in grown if f.endswith(".py")])
    assert status["stale"] is True and status["added"] == ["src/b"]


def test_the_record_never_follows_a_link(tmp_path: Path) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    project = tmp_path / "project"
    project.mkdir()
    (project / ".workpilot").symlink_to(outside, target_is_directory=True)

    save_fingerprint(project, "abc", [], [])

    assert list(outside.iterdir()) == []


# --- narration --------------------------------------------------------------


def test_the_narration_is_plain_text_for_the_known_chapters(repo: Path) -> None:
    package = OnboardingPackageBuilder().build(repo)
    prompts: list[str] = []

    def ask(prompt: str, _project: str | None) -> str:
        prompts.append(prompt)
        return json.dumps(
            {
                "critical": "**TokenService** is [the busiest](https://x.test) file. <b>Care.</b>",
                "invented": "A chapter nobody asked for.",
            }
        )

    result = narrate(package.story.chapters, "fr", ask=ask)

    assert result["paragraphs"] == {
        "critical": "TokenService is the busiest file. Care."
    }
    assert "structure" in result["missing"] and result["answered"]
    assert "<user_content>" in prompts[0] and "Language: French" in prompts[0]


def test_a_long_paragraph_is_cut_on_a_word() -> None:
    cut = clean_paragraph("word " * 400)

    assert len(cut) <= 901 and cut.endswith("word…")


def test_no_model_leaves_the_lines_as_they_are(repo: Path) -> None:
    package = OnboardingPackageBuilder().build(repo)

    def ask(_prompt: str, _project: str | None) -> str:
        raise RuntimeError("no provider")

    result = narrate(package.story.chapters, "en", ask=ask)

    assert result["paragraphs"] == {} and not result["answered"]


def test_an_unknown_language_is_refused(repo: Path) -> None:
    with pytest.raises(ValueError):
        narrate([], "xx")


# --- runner -----------------------------------------------------------------


def _runner(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            sys.executable,
            str(_BACKEND / "runners" / "onboarding_agent_runner.py"),
            *args,
        ],
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )


def _line(output: str, prefix: str) -> Any:
    for line in output.splitlines():
        if line.startswith(f"{prefix}:"):
            return json.loads(line[len(prefix) + 1 :])
    raise AssertionError(output)


def test_the_runner_saves_the_shape_and_reports_staleness(repo: Path) -> None:
    status = _line(
        _runner("--project-path", str(repo), "--status").stdout, "ONBOARDING_STATUS"
    )
    assert status["known"] is False

    result = _line(_runner("--project-path", str(repo)).stdout, "ONBOARDING_RESULT")
    assert (
        result["package"]["story"]["chapters"] and result["freshness"]["stale"] is False
    )
    assert (repo / ".workpilot" / "onboarding" / "tour.json").is_file()

    for name in ("A", "B", "C"):
        _write(repo / "src" / "Payments" / f"{name}.cs", "class P { }\n")
    status = _line(
        _runner("--project-path", str(repo), "--status").stdout, "ONBOARDING_STATUS"
    )
    assert status["stale"] is True and "src/Payments" in status["added"]


def test_the_runner_refuses_an_unknown_language(repo: Path) -> None:
    run = _runner("--project-path", str(repo), "--narrate", "--language", "xx")

    assert run.returncode == 1 and "ONBOARDING_ERROR" in run.stdout

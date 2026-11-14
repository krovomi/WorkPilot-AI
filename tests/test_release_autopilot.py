"""The release autopilot publishes develop to main on its own (scripts/release_autopilot.py).

Pure rules first (level of a change, next version, cadence, checks), then the
files of the release commit on copies, then the git part on throw-away
repositories: main must come back into develop with a merge commit, and a
conflict must stop instead of pushing markers. Last, the workflow itself.
"""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

yaml = pytest.importorskip("yaml")

ROOT = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location(
    "release_autopilot", ROOT / "scripts" / "release_autopilot.py"
)
ra = importlib.util.module_from_spec(_spec)
sys.modules["release_autopilot"] = ra
_spec.loader.exec_module(ra)

WORKFLOW = ROOT / ".github" / "workflows" / "release-autopilot.yml"
NOW = datetime(2026, 11, 14, 12, 0, tzinfo=UTC)


def _ago(hours: float) -> str:
    return (NOW - timedelta(hours=hours)).isoformat()


def _change(title, hours=5.0, number=1, body="", labels=()):
    return ra.Change(
        sha=f"{number:040d}",
        subject=f"{title} (#{number})",
        date=_ago(hours),
        number=number,
        title=title,
        body=body,
        labels=frozenset(labels),
    )


# -- level of one change -----------------------------------------------------


@pytest.mark.parametrize(
    ("title", "level"),
    [
        ("feat(coach): style profile per project", "minor"),
        ("feat: something", "minor"),
        ("fix(replay): reach the backend", "patch"),
        ("perf(board): faster columns", "patch"),
        ("refactor(core): split the client", "patch"),
        ("revert: feat(x)", "patch"),
        ("build(electron): new packager", "patch"),
        ("chore(deps): bump jsdom from 30.1.3 to 31.0.0", "patch"),
        ("chore(deps-dev): bump vitest", "patch"),
        ("ci(deps): bump softprops/action-gh-release", "none"),
        ("chore(upgrading-versions): upgrade dependencies", "none"),
        ("chore(release): 1.5.1", "none"),
        ("docs: carry the README", "none"),
        ("ci: shard the tests", "none"),
        ("test(e2e): one more spec", "none"),
        ("style: biome", "none"),
        ("feat!: drop the Continuous AI daemon", "major"),
        ("fix(api)!: rename a route", "major"),
        ("Release 1.5.0", "none"),
    ],
)
def test_level_from_the_conventional_title(title, level):
    assert ra.classify(title) == level


def test_breaking_footer_and_template_answer_make_a_major():
    assert ra.classify("fix: x", "Body\n\nBREAKING CHANGE: the route moved") == "major"
    assert ra.classify("fix: x", "BREAKING-CHANGE: gone") == "major"
    assert (
        ra.classify("fix: x", "## Breaking Changes\n\n**Breaking:** Yes\n") == "major"
    )
    assert ra.classify("fix: x", "**Breaking:** Oui") == "major"


def test_the_untouched_template_and_a_mention_are_not_breaking():
    # The "Breaking Changes" section of the pull request template, unanswered.
    template = (
        "## Breaking Changes\n\n"
        "<!-- Does this PR introduce breaking changes? If yes, describe what breaks. -->\n\n"
        "**Breaking:** Yes / No\n\n**Details:**\n"
    )
    assert ra.classify("fix: x", template) == "patch"
    assert ra.classify("fix: x", "**Breaking:** No") == "patch"
    assert ra.classify("fix: x", "no breaking change: none") == "patch"


def test_labels_override_or_fill_in():
    assert ra.classify("fix: x", labels={"semver:minor"}) == "minor"
    assert ra.classify("feat: x", labels={"semver:patch"}) == "patch"
    assert ra.classify("feat!: x", labels={"semver:none"}) == "none"
    assert ra.classify("fix: x", labels={"breaking"}) == "major"
    assert ra.classify("Add a thing", labels={"feature"}) == "minor"
    assert ra.classify("Repair a thing", labels={"bug"}) == "patch"


def test_the_strongest_level_wins():
    assert ra.strongest(["patch", "none", "minor"]) == "minor"
    assert ra.strongest(["major", "minor"]) == "major"
    assert ra.strongest([]) == "none"


def test_fragment_sections_have_a_level(tmp_path):
    for name, section in [
        ("a.md", "⚠️ Changement incompatible"),
        ("b.md", "✨ Nouveautés"),
        ("c.md", "🐛 Corrections"),
        ("d.md", "🧹 Maintenance"),
    ]:
        (tmp_path / name).write_text(
            f"---\nsection: {section}\n---\n\n- **x**.\n", encoding="utf-8"
        )
    (tmp_path / "README.md").write_text("ignored", encoding="utf-8")
    assert ra.fragment_levels(tmp_path) == ["major", "minor", "patch", "patch"]


# -- next version ------------------------------------------------------------


def test_bump_by_level():
    assert ra.bump("1.5.0", "patch") == "1.5.1"
    assert ra.bump("1.5.3", "minor") == "1.6.0"
    assert ra.bump("1.5.3", "major") == "2.0.0"
    with pytest.raises(ValueError):
        ra.bump("1.5.0", "none")
    with pytest.raises(ValueError):
        ra.bump("one", "patch")


def test_latest_stable_ignores_prereleases_and_sorts_numerically():
    tags = ["v1.4.1", "v1.10.0", "v1.9.9", "v2.0.0-beta.1", "vx", "1.2.3"]
    assert ra.latest_stable(tags) == "1.10.0"
    assert ra.latest_stable([]) is None


def test_target_version_from_the_tag_unless_bumped_by_hand():
    assert ra.target_version("1.5.0", "1.5.0", "patch") == "1.5.1"
    assert ra.target_version("1.5.0", "1.5.0", "minor") == "1.6.0"
    # Someone prepared 2.0.0 by hand: kept.
    assert ra.target_version("1.5.0", "2.0.0", "patch") == "2.0.0"
    # No tag yet: from the manifest.
    assert ra.target_version(None, "0.9.0", "minor") == "0.10.0"


# -- cadence -----------------------------------------------------------------


def _plan(changes, fragments=(), **kwargs):
    kwargs.setdefault("last_release", _ago(48))
    kwargs.setdefault("develop_state", "green")
    return ra.plan_release(list(changes), list(fragments), now=NOW, **kwargs)


def test_prepare_when_quiet_spaced_and_green():
    plan = _plan([_change("fix: a", 3), _change("feat: b", 4, number=2)])
    assert (plan.action, plan.level) == ("prepare", "minor")


def test_nothing_without_a_change_for_the_user():
    assert _plan([]).action == "nothing"
    assert _plan([_change("docs: a"), _change("ci: b", number=2)]).action == "nothing"


def test_a_fragment_raises_the_level():
    plan = _plan([_change("chore(deps): bump x")], ["minor"])
    assert (plan.action, plan.level) == ("prepare", "minor")


def test_waits_for_the_interval_then_for_quiet():
    assert _plan([_change("fix: a")], last_release=_ago(10)).action == "wait"
    assert _plan([_change("fix: a", 1)]).action == "wait"
    assert _plan([_change("fix: a", 1)], quiet_hours=0.5).action == "prepare"
    assert (
        _plan([_change("fix: a")], last_release=_ago(10), min_interval_hours=6).action
        == "prepare"
    )


def test_tooling_commits_are_neither_changes_nor_activity():
    own = ra.Change(
        sha="a" * 40,
        subject="chore(release): merge v1.5.0 back into develop",
        date=_ago(0.1),
    )
    readme = ra.Change(
        sha="b" * 40,
        subject="docs: merge the v1.5.0 README into develop [skip ci]",
        date=_ago(0.1),
    )
    assert own.tooling and readme.tooling
    assert _plan([own, readme]).action == "nothing"
    assert _plan([own, readme, _change("fix: a", 5)]).action == "prepare"


def test_waits_for_a_green_develop():
    assert _plan([_change("fix: a")], develop_state="pending").action == "wait"
    assert _plan([_change("fix: a")], develop_state="red").action == "wait"


def test_force_skips_the_cadence_but_never_a_red_develop():
    assert (
        _plan([_change("fix: a", 0.1)], last_release=_ago(1), force=True).action
        == "prepare"
    )
    assert _plan([_change("fix: a")], develop_state="red", force=True).action == "wait"
    assert _plan([_change("docs: a")], force=True).action == "nothing"


def test_pull_request_number_read_from_the_subject():
    assert ra.number_in_subject("fix(x): y (#884)") == 884
    assert ra.number_in_subject("Merge pull request #876 from krovomi/fix/a") == 876
    assert ra.number_in_subject("chore: direct push") is None


# -- checks ------------------------------------------------------------------


def test_runs_verdict():
    ok = {"name": "CI", "id": 1, "status": "completed", "conclusion": "success"}
    red = {"name": "Lint", "id": 2, "status": "completed", "conclusion": "failure"}
    running = {"name": "Mobile", "id": 3, "status": "in_progress", "conclusion": None}
    own = {"name": "Release autopilot", "id": 4, "status": "in_progress"}
    assert ra.runs_verdict([ok, own], 0) == "green"
    assert ra.runs_verdict([ok, red], 0) == "red"
    assert ra.runs_verdict([ok, running], 0) == "pending"
    # A re-run replaces the failed attempt.
    rerun = {**red, "id": 9, "conclusion": "success"}
    assert ra.runs_verdict([ok, red, rerun], 0) == "green"
    cancelled = {**ok, "id": 10, "conclusion": "cancelled"}
    assert ra.runs_verdict([ok, cancelled], 0) == "red"
    assert ra.runs_verdict([], 60) == "pending"
    assert ra.runs_verdict([], 3600) == "green"


# -- the release commit ------------------------------------------------------


def _copy_manifests(tmp_path: Path) -> Path:
    for relative in ra.VERSION_FILES:
        target = tmp_path / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes((ROOT / relative).read_bytes())
    return tmp_path


def test_every_manifest_gets_the_version_and_keeps_its_format(tmp_path):
    root = _copy_manifests(tmp_path)
    before = {r: (root / r).read_bytes() for r in ra.VERSION_FILES}
    ra.write_versions(root, "9.8.7")
    for relative in ra.VERSION_FILES:
        after = (root / relative).read_bytes()
        assert b"9.8.7" in after, relative
        # One line changed, indentation and line endings kept.
        old_lines, new_lines = before[relative].splitlines(True), after.splitlines(True)
        assert len(old_lines) == len(new_lines)
        assert sum(a != b for a, b in zip(old_lines, new_lines, strict=True)) == 1
    for name in (
        "package.json",
        "apps/frontend/package.json",
        "apps/mobile/package.json",
    ):
        assert (
            json.loads((root / name).read_text(encoding="utf-8"))["version"] == "9.8.7"
        )
    app = json.loads((root / "apps/mobile/app.json").read_text(encoding="utf-8"))
    assert app["expo"]["version"] == "9.8.7"


def test_the_manifests_list_covers_every_file_bump_version_touches():
    script = (ROOT / "scripts" / "bump-version.js").read_text(encoding="utf-8")
    for touched in (
        "apps/frontend/package.json",
        "package.json",
        "apps/backend/__init__.py",
    ):
        assert touched in script or touched.split("/")[-1] in script
        assert touched in ra.VERSION_FILES
    current = json.loads(
        (ROOT / "apps/frontend/package.json").read_text(encoding="utf-8")
    )["version"]
    for relative in ra.VERSION_FILES:
        assert current in (ROOT / relative).read_text(encoding="utf-8"), relative


def test_write_versions_refuses_a_bad_version_or_a_missing_field(tmp_path):
    root = _copy_manifests(tmp_path)
    with pytest.raises(ValueError):
        ra.write_versions(root, "1.2")
    (root / "apps/backend/__init__.py").write_text("x = 1\n", encoding="utf-8")
    with pytest.raises(RuntimeError):
        ra.write_versions(root, "1.2.3")


def _changelog(tmp_path):
    fragments = tmp_path / "changelog.d"
    fragments.mkdir()
    (fragments / "README.md").write_text("doc", encoding="utf-8")
    path = tmp_path / "CHANGELOG.md"
    path.write_text(
        "# Changelog\n\nIntro.\n\n## 1.5.0 - Before\n\n- old\n", encoding="utf-8"
    )
    return fragments, path


def _extract(path: Path, version: str) -> str:
    """The notes prepare-release.yml reads: from the header to the next ## or ---."""
    out, found = [], False
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("## "):
            if found:
                break
            found = line.split()[1] == version
            continue
        if line == "---" and found:
            break
        if found:
            out.append(line)
    return "\n".join(out).strip()


def test_fragments_are_folded_with_an_intro(tmp_path):
    fragments, path = _changelog(tmp_path)
    (fragments / "fix-a.md").write_text(
        "---\nsection: 🐛 Corrections\n---\n\n- **A is fixed**.\n", encoding="utf-8"
    )
    changes = [_change("fix: a", number=884), _change("docs: b", number=885)]
    assert ra.write_changelog("1.5.1", "patch", changes, "1.5.0", fragments, path)
    text = path.read_text(encoding="utf-8")
    assert "## 1.5.1 - Corrections et maintenance" in text
    assert text.index("## 1.5.1") < text.index("## 1.5.0")
    notes = _extract(path, "1.5.1")
    assert "**A is fixed**" in notes
    assert "#884" in notes and "depuis v1.5.0" in notes
    assert "<!--" not in notes
    assert not (fragments / "fix-a.md").exists()
    assert (fragments / "README.md").exists()


def test_without_fragment_the_pull_requests_are_the_notes(tmp_path):
    fragments, path = _changelog(tmp_path)
    changes = [
        _change("chore(deps): bump jsdom from 30.1.3 to 31.0.0", number=872),
        _change("ci(deps): bump an action", number=870),
    ]
    assert ra.write_changelog("1.5.1", "patch", changes, "1.5.0", fragments, path)
    notes = _extract(path, "1.5.1")
    assert "### 🧹 Maintenance" in notes
    assert "bump jsdom" in notes and "(#872)" in notes
    assert "bump an action" not in notes
    assert list(fragments.glob("*.md")) == [fragments / "README.md"]


def test_a_version_already_written_by_hand_is_left_alone(tmp_path):
    fragments, path = _changelog(tmp_path)
    before = path.read_text(encoding="utf-8")
    assert not ra.write_changelog(
        "1.5.0", "patch", [_change("fix: a")], "1.4.1", fragments, path
    )
    assert path.read_text(encoding="utf-8") == before


def test_the_pull_request_body_lists_each_change_and_its_level():
    body = ra.pr_body(
        "1.6.0",
        "minor",
        [_change("feat: a|b", number=7), _change("fix: c", number=8)],
        "1.5.0",
    )
    assert "v1.6.0" in body and "v1.5.0" in body
    assert "| #7 | feat: a/b | minor |" in body
    assert "| #8 | fix: c | patch |" in body
    assert "commit de merge" in body


# -- git: main back into develop ---------------------------------------------


def _sh(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args],
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    ).stdout.strip()


def _repos(tmp_path: Path) -> tuple[Path, Path]:
    origin = tmp_path / "origin.git"
    _sh(tmp_path, "init", "-q", "--bare", "-b", "develop", str(origin))
    work = tmp_path / "work"
    _sh(tmp_path, "clone", "-q", str(origin), str(work))
    for key, value in (("user.name", "t"), ("user.email", "t@example.com")):
        _sh(work, "config", key, value)
    (work / "package.json").write_text('{\n\t"version": "1.0.0"\n}\n', encoding="utf-8")
    (work / "a.txt").write_text("a\n", encoding="utf-8")
    _sh(work, "add", ".")
    _sh(work, "commit", "-q", "-m", "init")
    _sh(work, "push", "-q", "origin", "HEAD:develop", "HEAD:main")
    return origin, work


def _release_on_main(work: Path, version: str) -> None:
    """What the merged release PR leaves: main = merge of the release branch."""
    _sh(work, "checkout", "-q", "-B", "rel", "origin/develop")
    (work / "package.json").write_text(
        f'{{\n\t"version": "{version}"\n}}\n', encoding="utf-8"
    )
    _sh(work, "commit", "-q", "-am", f"chore(release): {version}")
    _sh(work, "checkout", "-q", "-B", "main", "origin/main")
    _sh(work, "merge", "-q", "--no-ff", "-m", "Release", "rel")
    _sh(work, "push", "-q", "origin", "main")


def test_merge_back_brings_the_release_into_develop(tmp_path):
    _, work = _repos(tmp_path)
    # develop moves on while the release is open.
    _sh(work, "checkout", "-q", "-B", "develop", "origin/develop")
    (work / "b.txt").write_text("b\n", encoding="utf-8")
    _sh(work, "add", ".")
    _sh(work, "commit", "-q", "-m", "fix: b (#2)")
    _sh(work, "push", "-q", "origin", "develop")
    _release_on_main(work, "1.0.1")

    assert ra.merge_back(work, "1.0.1") == "merged"
    _sh(work, "fetch", "-q", "origin")
    head = "origin/develop"
    assert (
        _sh(work, "log", "-1", "--format=%s", head)
        == "chore(release): merge v1.0.1 back into develop"
    )
    assert len(_sh(work, "log", "-1", "--format=%P", head).split()) == 2
    assert '"1.0.1"' in _sh(work, "show", f"{head}:package.json")
    assert _sh(work, "show", f"{head}:b.txt") == "b"
    # Idempotent: main is now in develop.
    assert ra.merge_back(work, "1.0.1") == "up-to-date"


def test_merge_back_stops_on_a_conflict_without_pushing(tmp_path):
    _, work = _repos(tmp_path)
    _release_on_main(work, "1.0.1")
    # develop changed the same line since the release was cut.
    _sh(work, "checkout", "-q", "-B", "develop", "origin/develop")
    (work / "package.json").write_text('{\n\t"version": "7.0.0"\n}\n', encoding="utf-8")
    _sh(work, "commit", "-q", "-am", "chore: hand bump")
    _sh(work, "push", "-q", "origin", "develop")
    _sh(work, "fetch", "-q", "origin")
    before = _sh(work, "rev-parse", "origin/develop")

    assert ra.merge_back(work, "1.0.1") == "conflict"
    _sh(work, "fetch", "-q", "origin")
    assert _sh(work, "rev-parse", "origin/develop") == before
    assert _sh(work, "status", "--porcelain") == ""


# -- the workflow ------------------------------------------------------------


def _workflow() -> dict:
    return yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))


def test_workflow_triggers_and_one_run_at_a_time():
    data = _workflow()
    on = data.get("on", data.get(True))
    assert set(on) == {"workflow_run", "schedule", "workflow_dispatch"}
    assert "CI" in on["workflow_run"]["workflows"]
    assert "pull_request_target" not in on and "pull_request" not in on
    assert data["concurrency"] == {
        "group": "release-autopilot",
        "cancel-in-progress": False,
    }


def test_workflow_runs_develops_script_with_the_pat_and_can_be_switched_off():
    job = _workflow()["jobs"]["release-autopilot"]
    assert job["name"] in ra.OWN_CHECKS
    assert "RELEASE_AUTOPILOT != 'off'" in job["if"]
    checkout = job["steps"][0]
    assert checkout["with"]["ref"] == "develop"
    assert checkout["with"]["fetch-depth"] == 0
    run = job["steps"][-1]
    assert "secrets.PAT_TOKEN" in run["env"]["PAT_TOKEN"]
    assert "scripts/release_autopilot.py" in run["run"]
    # No untrusted event text reaches the shell.
    assert "${{" not in run["run"]


def test_main_only_ever_gets_a_merge_commit():
    source = (ROOT / "scripts" / "release_autopilot.py").read_text(encoding="utf-8")
    assert ra.MERGE_METHOD == "merge"
    assert "squash" not in source and "rebase" not in source
    assert '"--no-ff"' in source


# -- documentation of the version --------------------------------------------


def test_section_notes_is_what_prepare_release_reads(tmp_path):
    fragments, path = _changelog(tmp_path)
    ra.write_changelog(
        "1.5.1",
        "patch",
        [_change("chore(deps): bump a", number=3)],
        "1.5.0",
        fragments,
        path,
    )
    text = path.read_text(encoding="utf-8")
    assert ra.section_notes(text, "1.5.1") == _extract(path, "1.5.1")
    assert ra.section_notes(text, "9.9.9") == ""


def test_the_pull_request_says_what_happened_to_the_documentation():
    written = ra.release_docs.DocsResult("written", files=["README.md", "README.fr.md"])
    assert "`README.fr.md`" in ra.docs_line(written)
    skipped = ra.release_docs.DocsResult("skipped", "CLI claude absent")
    line = ra.docs_line(skipped)
    assert "CLI claude absent" in line and ra.DOCS_LABEL in line
    body = ra.pr_body("1.5.1", "patch", [_change("fix: a")], "1.5.0", written)
    assert "mise à jour par Claude Code" in body


def test_missing_documentation_holds_the_merge():
    class NoCall:
        def __getattr__(self, name):
            raise AssertionError(f"GitHub called: {name}")

    pilot = ra.ReleaseAutopilot(
        NoCall(), can_push=True, quiet_hours=2, min_interval_hours=24, force=False
    )
    pr = ra.ReleasePR(9, "release/v1.5.1", "a" * 40, {ra.LABEL, ra.DOCS_LABEL})
    assert pilot.advance(pr) is False


def test_change_lines_leave_tooling_out():
    own = ra.Change(sha="a" * 40, subject="chore(release): 1.5.0", date=_ago(1))
    lines = ra.change_lines([_change("fix: a", number=5), own])
    assert lines == "- #5 [patch] fix: a"

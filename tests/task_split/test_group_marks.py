"""A split part's PR says which group it belongs to: colour, label, title, body.

The colour is a hash the desktop, the phone and the backend compute the same
way; the forge marks come from the part's and its siblings' metadata. ``gh``
and ``glab`` are simulated: no test reaches a forge.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest
from board_mcp.server import summary
from core import pr_group
from core.pr_group import append_section, apply_group_label, decoration_for
from task_split.group import (
    GROUP_COLORS,
    group_label,
    group_section,
    group_title,
    group_tone,
    part_group,
)

# The same fixtures as task-split.test.ts and the phone's board test.
TONES = {
    "012-add-oauth": "green",
    "001-x": "violet",
    "abc": "orange",
    "é-123": "blue",
    "999-very-long-name-here": "orange",
}


@pytest.mark.parametrize(("group", "tone"), TONES.items())
def test_a_group_has_the_same_tone_everywhere(group, tone):
    assert group_tone(group) == tone
    assert tone in GROUP_COLORS


def test_the_label_fits_a_github_label():
    assert group_label("012-add-oauth") == "groupe/012-add-oauth"
    long = group_label("012-" + "a" * 120)
    assert len(long) <= 50 and long.startswith("groupe/012-")


def _write(spec_dir: Path, metadata: dict) -> Path:
    spec_dir.mkdir(parents=True, exist_ok=True)
    (spec_dir / "task_metadata.json").write_text(json.dumps(metadata), encoding="utf-8")
    return spec_dir


@pytest.fixture
def specs(tmp_path: Path) -> Path:
    root = tmp_path / ".workpilot" / "specs"
    _write(
        root / "012-oauth",
        {
            "splitGroup": {
                "children": ["012-oauth-part1", "012-oauth-part2", "../escape"],
                "total": 2,
            }
        },
    )
    _write(
        root / "012-oauth-part1",
        {
            "splitGroup": {
                "parent": "012-oauth",
                "title": "OAuth Google",
                "index": 1,
                "total": 2,
                "name": "API",
            },
            "prUrl": "https://github.com/acme/shop/pull/12",
        },
    )
    _write(
        root / "012-oauth-part2",
        {
            "splitGroup": {
                "parent": "012-oauth",
                "title": "OAuth Google",
                "index": 2,
                "total": 2,
                "name": "Login screen",
            },
            "blockedBy": ["012-oauth-part1"],
        },
    )
    return root


def test_part_group_reads_the_part_and_its_siblings(specs):
    group = part_group(specs / "012-oauth-part2")
    assert group is not None
    assert (group.group_id, group.index, group.total, group.name) == (
        "012-oauth",
        2,
        2,
        "Login screen",
    )
    assert group.after == "012-oauth-part1"
    assert [(s.index, s.spec_id, s.pr_url) for s in group.siblings] == [
        (1, "012-oauth-part1", "https://github.com/acme/shop/pull/12"),
        (2, "012-oauth-part2", None),
    ]
    assert group.label == "groupe/012-oauth"
    assert group.color == GROUP_COLORS[group_tone("012-oauth")]


@pytest.mark.parametrize(
    "metadata",
    [
        {},
        {"splitGroup": {"children": ["a"]}},
        {"splitGroup": {"parent": "012-x", "index": 3, "total": 2}},
        {"splitGroup": {"parent": "", "index": 1, "total": 2}},
        {"splitGroup": "nope"},
    ],
)
def test_a_card_that_is_not_a_part_has_no_group(tmp_path, metadata):
    assert part_group(_write(tmp_path / "001-x", metadata)) is None
    assert decoration_for(tmp_path / "001-x") is None


def test_the_title_gets_the_group_prefix_once(specs):
    group = part_group(specs / "012-oauth-part2")
    assert group_title("OAuth Google (2/2): Login screen", group) == (
        "[OAuth Google 2/2] Login screen"
    )
    assert group_title("feat: 012-oauth-part2", group) == (
        "[OAuth Google 2/2] feat: 012-oauth-part2"
    )
    once = group_title("[OAuth Google 2/2] Login screen", group)
    assert once == "[OAuth Google 2/2] Login screen"


def test_the_section_lists_the_parts_in_the_apps_language(specs):
    group = part_group(specs / "012-oauth-part2")
    english = group_section(group, "en")
    assert english.startswith("## PR group\n")
    assert "part 2 of 2 of “OAuth Google” (label `groupe/012-oauth`)" in english
    assert "It builds on part 1" in english
    assert "| 1/2 | API | https://github.com/acme/shop/pull/12 |" in english
    assert "| 2/2 | Login screen | **this PR** |" in english
    french = group_section(group, "fr-FR")
    assert french.startswith("## Groupe de PR\n")
    assert "partie 2 sur 2 de « OAuth Google »" in french


def test_append_section_adds_it_once():
    assert append_section("Body", "## PR group\nx\n") == "Body\n\n## PR group\nx\n"
    assert (
        append_section("Body\n\n## PR group\nx\n", "## PR group\nx\n").count("PR group")
        == 1
    )
    assert append_section(None, "## S\n") == "## S\n"
    assert append_section("Body", "") == "Body"


class _Run:
    def __init__(self, code: int = 0):
        self.code = code
        self.calls: list[list[str]] = []

    def __call__(self, args, **_kwargs):
        self.calls.append(list(args))
        return subprocess.CompletedProcess(args, self.code, "", "boom")


def test_github_label_is_created_in_the_group_colour_then_put(specs, monkeypatch):
    run = _Run()
    monkeypatch.setattr(pr_group.subprocess, "run", run)
    group = part_group(specs / "012-oauth-part2")
    url = "https://github.com/acme/shop/pull/13"
    assert apply_group_label("github", "gh", specs, url, group) is True
    assert run.calls[0][:4] == ["gh", "label", "create", "groupe/012-oauth"]
    assert run.calls[0][run.calls[0].index("--color") + 1] == group.color
    assert run.calls[1] == ["gh", "pr", "edit", url, "--add-label", "groupe/012-oauth"]


def test_gitlab_label_goes_through_its_api(specs, monkeypatch):
    run = _Run()
    monkeypatch.setattr(pr_group.subprocess, "run", run)
    group = part_group(specs / "012-oauth-part2")
    url = "https://gitlab.com/acme/shop/-/merge_requests/7"
    assert apply_group_label("gitlab", "glab", specs, url, group) is True
    assert run.calls[0][:5] == ["glab", "api", "-X", "POST", "projects/:id/labels"]
    assert f"color=#{group.color}" in run.calls[0]
    assert run.calls[1] == [
        "glab",
        "api",
        "-X",
        "PUT",
        "projects/:id/merge_requests/7",
        "-f",
        "add_labels=groupe/012-oauth",
    ]


def test_no_label_on_azure_without_a_tool_or_a_pr_and_a_failure_is_only_logged(
    specs, monkeypatch
):
    run = _Run(code=1)
    monkeypatch.setattr(pr_group.subprocess, "run", run)
    group = part_group(specs / "012-oauth-part2")
    url = "https://github.com/acme/shop/pull/13"
    assert apply_group_label("azure_devops", "x", specs, url, group) is False
    assert apply_group_label("github", None, specs, url, group) is False
    assert apply_group_label("github", "gh", specs, None, group) is False
    assert run.calls == []
    assert apply_group_label("github", "gh", specs, url, group) is False
    assert len(run.calls) == 2


def test_the_board_card_of_a_part_carries_its_group(specs):
    card = summary(specs / "012-oauth-part2")
    assert card["group"] == {
        "id": "012-oauth",
        "title": "OAuth Google",
        "index": 2,
        "total": 2,
    }
    assert "group" not in summary(specs / "012-oauth")


def test_push_and_create_pr_marks_a_parts_pr(specs, monkeypatch):
    import core.worktree_pr as worktree_pr
    from core.worktree import WorktreeManager

    project = specs.parent.parent
    subprocess.run(["git", "init", "-q", "-b", "develop"], cwd=project, check=True)
    labels: list[tuple] = []
    monkeypatch.setattr(worktree_pr, "detect_git_provider", lambda *_a, **_k: "github")
    monkeypatch.setattr(worktree_pr, "get_gh_executable", lambda: "gh")
    monkeypatch.setattr(
        pr_group, "apply_group_label", lambda *a: labels.append(a) or True
    )
    manager = WorktreeManager(project, base_branch="develop")
    for name, value in {
        "_cross_review_hold": lambda _s: None,
        "_has_uncommitted_changes": lambda _s: (False, []),
        "_apply_discard_list": lambda *_a: [],
        "_strip_workpilot_artifacts": lambda _s: [],
        "strip_build_artifacts": lambda _s: None,
        "_count_commits_ahead": lambda *_a: 1,
        "push_branch": lambda spec, force=False: {
            "success": True,
            "branch": f"workpilot/{spec}",
            "remote": "origin",
        },
    }.items():
        monkeypatch.setattr(manager, name, value)
    created: list[dict] = []
    monkeypatch.setattr(
        manager,
        "create_pull_request",
        lambda **kw: (
            created.append(kw)
            or {"success": True, "pr_url": "https://github.com/acme/shop/pull/13"}
        ),
    )
    result = manager.push_and_create_pr(
        spec_name="012-oauth-part2",
        target_branch="develop",
        title="OAuth Google (2/2): Login screen",
        body="b",
    )
    assert result["success"] is True
    assert created[0]["title"] == "[OAuth Google 2/2] Login screen"
    assert "groupe/012-oauth" in created[0]["body_suffix"]
    assert labels and labels[0][0] == "github" and labels[0][3].endswith("/pull/13")

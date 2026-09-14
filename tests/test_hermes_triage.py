"""The second authority over hermes's catalogue, and the queue it keeps clean.

`test_hermes_agent.py` covers the first one: hermes's own bookkeeping, which
says what hermes authored. This file covers what happens when that bookkeeping
is absent, renamed, or means something else than it used to — which is not a
hypothetical, it is how sixty candidates reached a review queue twice, for two
different reasons.

The property under test throughout: **a flood needs both authorities to fail at
once**, and the second one reads files this repository owns, so an upstream
release cannot break it. The other property, equally load-bearing: a skill
hermes genuinely learned still gets through. A filter that proposes nothing is
not a fix, it is the feature turned off.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from hermes import run_cycle  # noqa: E402
from learning_loop.hermes_ingest import (  # noqa: E402
    ingest_hermes_skills,
    queue_state,
    recorded_facts,
)
from learning_loop.hermes_triage import (  # noqa: E402
    DEFAULT_CATEGORIES,
    RepoScope,
    read_scope,
    verdict_for,
)

# The frontmatter hermes requires of a skill contributed to its repository. A
# skill `skill_manage(action='create')` writes from a session's experience has
# to satisfy the validator instead, which asks for name, description and a body.
CATALOGUE = "version: 1.1.0\nauthor: community\nlicense: MIT\n"


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    """A checkout that declares the same hermes scope this repository does."""
    root = tmp_path / "repo"
    (root / "skills" / "hermes").mkdir(parents=True)
    (root / "skills" / "hermes" / "pack.json").write_text(
        json.dumps(
            {
                "name": "hermes",
                "bootstrap": {
                    "command": [
                        "python3",
                        "scripts/vendor_pack.py",
                        "NousResearch/hermes-agent",
                        "--into",
                        "skills/hermes",
                        "--subdir",
                        "skills/software-development",
                        "--subdir",
                        "skills/autonomous-ai-agents",
                        "--subdir",
                        "skills/devops",
                        "--exclude",
                        "test-driven-development",
                        "--exclude",
                        "dogfood",
                    ]
                },
            }
        ),
        encoding="utf-8",
    )
    return root


@pytest.fixture
def home(tmp_path: Path) -> Path:
    root = tmp_path / "hermes-home"
    (root / "skills").mkdir(parents=True)
    return root


def _skill(home: Path, category: str, name: str, frontmatter: str = "") -> Path:
    """A skill in hermes's own layout: `<home>/skills/<maybe-category>/<name>/`."""
    base = home / "skills"
    path = (base / category / name if category else base / name) / "SKILL.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        f"---\nname: {name}\ndescription: A procedure.\n{frontmatter}---\n\n"
        "Read the log with `read_file`, then `patch` the offending line.\n",
        encoding="utf-8",
    )
    return path


def _claim_authorship(home: Path, *names: str) -> None:
    """`.usage.json` saying the agent wrote them — the record that fails open."""
    (home / "skills" / ".usage.json").write_text(
        json.dumps({name: {"created_by": "agent"} for name in names}), encoding="utf-8"
    )


class TestScope:
    """What this repository already decided, read from where it wrote it down."""

    def test_the_categories_come_from_the_pack_declaration(self, repo):
        scope = read_scope(repo)
        assert scope.categories == frozenset(
            {"software-development", "autonomous-ai-agents", "devops"}
        )

    def test_the_declined_names_come_from_the_same_place(self, repo):
        assert read_scope(repo).declined == frozenset(
            {"test-driven-development", "dogfood"}
        )

    def test_an_unreadable_pack_leaves_the_rule_standing(self, tmp_path):
        """Fails closed. A rule that disappears with its configuration is the
        fail-open shape this module was written to replace."""
        empty = tmp_path / "bare"
        empty.mkdir()
        assert read_scope(empty).categories == DEFAULT_CATEGORIES

    def test_what_the_packs_already_provide_is_read_from_disk(self, repo):
        skill = repo / "skills" / "tooling" / "mem-search" / "SKILL.md"
        skill.parent.mkdir(parents=True)
        skill.write_text("---\nname: mem-search\n---\n\nBody.\n", encoding="utf-8")
        assert "mem-search" in read_scope(repo).provided

    def test_the_emitted_set_counts_too(self, repo):
        skill = repo / ".agents" / "skills" / "architecture-map" / "SKILL.md"
        skill.parent.mkdir(parents=True)
        skill.write_text(
            "---\nname: architecture-map\n---\n\nBody.\n", encoding="utf-8"
        )
        assert "architecture-map" in read_scope(repo).provided

    def test_the_real_repository_declares_the_three_categories(self):
        """The fixtures above mirror `skills/hermes/pack.json`; this checks they do."""
        assert read_scope(REPO_ROOT).categories == DEFAULT_CATEGORIES


class TestVerdict:
    def _scope(self) -> RepoScope:
        return RepoScope(
            categories=frozenset({"software-development"}),
            declined=frozenset({"dogfood"}),
            provided=frozenset({"mem-search"}),
        )

    def test_a_name_this_repository_already_has_is_not_news(self):
        assert not verdict_for("mem-search", scope=self._scope()).keep

    def test_a_name_the_pack_turned_down_is_not_reopened(self):
        verdict = verdict_for("dogfood", scope=self._scope())
        assert not verdict.keep and verdict.reason == "declined-here"

    def test_a_category_this_repository_does_not_track_is_out(self):
        verdict = verdict_for("airtable", category="productivity", scope=self._scope())
        assert not verdict.keep and verdict.reason == "out-of-scope"

    def test_a_tracked_category_is_in(self):
        assert verdict_for(
            "diagnose-the-flake", category="software-development", scope=self._scope()
        ).keep

    def test_the_contributed_frontmatter_shape_is_out_even_with_no_category(self):
        """The flat home is the case the path rules cannot see, and the one the
        flood arrived in."""
        verdict = verdict_for("songsee", catalogue=True, scope=self._scope())
        assert not verdict.keep and verdict.reason == "upstream-catalogue"

    def test_a_learned_skill_with_neither_marker_gets_through(self):
        assert verdict_for("diagnose-the-flake", scope=self._scope()).keep


class TestTheFloodWithHermesBookkeepingGone:
    """The failure that produced sixty-one files: upstream's records fail open.

    Here `.usage.json` claims the agent authored the whole catalogue and there
    is no `.bundled_manifest` to subtract it — the exact shape of a hermes
    release that changed what it records. The first authority passes every one
    of them; the second one has to hold alone.
    """

    CATALOGUE_NAMES = ("airtable", "imessage", "apple-notes", "maps", "arxiv")

    def test_a_catalogue_claiming_authorship_proposes_nothing(self, repo, home):
        for name in self.CATALOGUE_NAMES:
            _skill(home, "productivity", name, CATALOGUE)
        _claim_authorship(home, *self.CATALOGUE_NAMES)

        report = ingest_hermes_skills(repo, home=home)

        assert report.found == len(self.CATALOGUE_NAMES)
        assert report.written == []
        assert report.dropped == {"out-of-scope": len(self.CATALOGUE_NAMES)}
        queue = repo / "skills" / "_proposed"
        assert not queue.is_dir() or list(queue.glob("*.md")) == []

    def test_a_flat_catalogue_is_caught_by_its_frontmatter(self, repo, home):
        """No category directories to compare against — the other rule answers."""
        for name in self.CATALOGUE_NAMES:
            _skill(home, "", name, CATALOGUE)
        _claim_authorship(home, *self.CATALOGUE_NAMES)

        report = ingest_hermes_skills(repo, home=home)
        assert report.dropped == {"upstream-catalogue": len(self.CATALOGUE_NAMES)}

    def test_what_hermes_actually_learned_still_gets_through(self, repo, home):
        """The property a filter can quietly break: the feature still works."""
        for name in self.CATALOGUE_NAMES:
            _skill(home, "productivity", name, CATALOGUE)
        _skill(home, "", "diagnose-the-flake")
        _claim_authorship(home, *self.CATALOGUE_NAMES, "diagnose-the-flake")

        report = ingest_hermes_skills(repo, home=home)

        assert [p.name for p in report.written] == ["hermes--diagnose-the-flake.md"]
        assert report.dropped_total == len(self.CATALOGUE_NAMES)

    def test_the_approval_queue_is_triaged_too(self, repo, home):
        """`pending/skills/` is admitted without a record, not without a scope."""
        staged = home / "pending" / "skills" / "productivity" / "notion" / "SKILL.md"
        staged.parent.mkdir(parents=True)
        staged.write_text(
            f"---\nname: notion\ndescription: d\n{CATALOGUE}---\n\nBody.\n",
            encoding="utf-8",
        )
        report = ingest_hermes_skills(repo, home=home)
        assert report.written == []
        assert report.dropped == {"out-of-scope": 1}

    def test_the_queue_keeps_its_frontmatter_exemption(self, repo, home):
        """A staged skill is authored by definition, whatever it copied from a
        peer — and it is the one input whose provenance no record can fail open
        on. The fingerprint would otherwise silence the loop's best source."""
        staged = home / "pending" / "skills" / "diagnose-the-flake" / "SKILL.md"
        staged.parent.mkdir(parents=True)
        staged.write_text(
            f"---\nname: diagnose-the-flake\ndescription: d\n{CATALOGUE}---\n\nBody.\n",
            encoding="utf-8",
        )
        report = ingest_hermes_skills(repo, home=home)
        assert [p.name for p in report.written] == ["hermes--diagnose-the-flake.md"]

    def test_a_run_that_filed_nothing_says_which_kind_of_nothing(self, repo, home):
        for name in self.CATALOGUE_NAMES:
            _skill(home, "productivity", name, CATALOGUE)
        _claim_authorship(home, *self.CATALOGUE_NAMES)
        report = ingest_hermes_skills(repo, home=home)
        assert "out of scope" in report.reason
        assert "out of scope" in report.describe()


class TestTheQueueCleansItself:
    """A rule that changed has to reach the files the old rule produced."""

    def _legacy(self, repo: Path, home: Path, name: str, category: str) -> Path:
        """A candidate as the renderer wrote them before triage existed.

        It recorded neither the category nor the catalogue shape, which is why
        `recorded_facts` falls back to the source path it does record.
        """
        queue = repo / "skills" / "_proposed"
        queue.mkdir(parents=True, exist_ok=True)
        path = queue / f"hermes--{name}.md"
        source = home / "skills" / category / name / "SKILL.md"
        path.write_text(
            f"---\nname: {name}\ndescription: d\nmetadata:\n  workpilot:\n"
            f"    proposal:\n      origin: hermes-agent\n      skill: {name}\n"
            f"      category: uncategorised\n      state: active in hermes\n"
            f"      surface: build\n      digest: deadbeef\n---\n\n"
            f"## Proposed skill\n\nBody.\n\n## Provenance\n\n"
            f"Read from `{source}` (active in hermes).\n",
            encoding="utf-8",
        )
        return path

    def test_sixty_files_from_an_older_rule_are_withdrawn_without_anyone(
        self, repo, home
    ):
        for name in ("airtable", "imessage", "apple-notes"):
            _skill(home, "productivity", name, CATALOGUE)
            self._legacy(repo, home, name, "productivity")

        report = ingest_hermes_skills(repo, home=home)

        assert len(report.pruned) == 3
        assert list((repo / "skills" / "_proposed").glob("hermes--*.md")) == []

    def test_a_legacy_candidate_whose_source_is_gone_is_still_judged(self, repo, home):
        """The category is in the path it recorded; no re-read is needed for it."""
        self._legacy(repo, home, "airtable", "productivity")
        report = ingest_hermes_skills(repo, home=home)
        assert len(report.pruned) == 1

    def test_an_in_scope_candidate_is_never_touched(self, repo, home):
        _skill(home, "software-development", "diagnose-the-flake")
        kept = self._legacy(repo, home, "diagnose-the-flake", "software-development")
        report = ingest_hermes_skills(repo, home=home)
        assert report.pruned == []
        assert kept.exists()

    def test_the_learning_loops_own_proposals_are_not_ours_to_delete(self, repo, home):
        """They carry the evidence of a build. `recorded_facts` refuses them."""
        queue = repo / "skills" / "_proposed"
        queue.mkdir(parents=True)
        mine = queue / "code-reviewer--pattern-7.md"
        mine.write_text(
            "---\nname: x\n---\n\nCorroborated by two builds.\n", encoding="utf-8"
        )

        self._legacy(repo, home, "airtable", "productivity")
        ingest_hermes_skills(repo, home=home)

        assert mine.exists()
        assert recorded_facts(mine) is None

    def test_the_queue_is_cleaned_even_when_hermes_is_not_installed(
        self, repo, tmp_path
    ):
        """The queue belongs to this repository, not to the machine's hermes."""
        self._legacy(repo, tmp_path / "nowhere", "airtable", "productivity")
        report = ingest_hermes_skills(repo, home=tmp_path / "nowhere")
        assert len(report.pruned) == 1
        assert "not installed" in report.reason

    def test_a_dry_run_withdraws_nothing(self, repo, home):
        path = self._legacy(repo, home, "airtable", "productivity")
        report = ingest_hermes_skills(repo, home=home, write=False)
        assert len(report.pruned) == 1
        assert path.exists()


class TestQueueState:
    """What a person is asked to read, which is not what is on disk."""

    def test_stale_candidates_are_counted_and_not_listed(self, repo, home):
        TestTheQueueCleansItself()._legacy(repo, home, "airtable", "productivity")
        _skill(home, "software-development", "diagnose-the-flake")
        _claim_authorship(home, "diagnose-the-flake")
        ingest_hermes_skills(repo, home=home)

        pending, stale = queue_state(repo)
        assert pending == ["hermes--diagnose-the-flake.md"]
        assert stale == 0

    def test_reading_the_queue_deletes_nothing(self, repo, home):
        path = TestTheQueueCleansItself()._legacy(
            repo, home, "airtable", "productivity"
        )
        pending, stale = queue_state(repo)
        assert pending == [] and stale == 1
        assert path.exists()


class TestTheCycleReportsWhatItSettled:
    def test_the_counts_reach_the_panel(self, repo, home):
        for name in ("airtable", "imessage"):
            _skill(home, "productivity", name, CATALOGUE)
        _claim_authorship(home, "airtable", "imessage")

        payload = run_cycle(repo, surface="kanban", home=home).to_dict()

        assert payload["ingest"]["droppedTotal"] == 2
        assert payload["ingest"]["dropped"] == {"out-of-scope": 2}
        assert payload["ingest"]["pruned"] == 0

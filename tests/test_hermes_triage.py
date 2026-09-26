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
from learning_loop.hermes_adopt import (  # noqa: E402
    ADOPTED_PACK,
    adoption_enabled,
    ledger_names,
)
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


@pytest.fixture(autouse=True)
def _no_brain(tmp_path, monkeypatch):
    """A kept skill is filed in the brain (`hermes.brain_link`): never in the
    brain of whoever runs the suite."""
    monkeypatch.setenv("WORKPILOT_BRAIN_DIR", str(tmp_path / "absent-brain"))


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
    """`.usage.json` saying the agent wrote them — the record that fails open.

    Merges rather than replaces: hermes appends to this file, and a helper that
    overwrote it made "five authored skills" silently mean one.
    """
    usage = home / "skills" / ".usage.json"
    data = {}
    if usage.is_file():
        data = json.loads(usage.read_text(encoding="utf-8"))
    for name in names:
        data[name] = {"created_by": "agent"}
    usage.write_text(json.dumps(data), encoding="utf-8")


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

        assert [p.parent.name for p in report.adopted] == ["diagnose-the-flake"]
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
        assert [p.parent.name for p in report.adopted] == ["diagnose-the-flake"]

    def test_a_run_that_filed_nothing_says_which_kind_of_nothing(self, repo, home):
        for name in self.CATALOGUE_NAMES:
            _skill(home, "productivity", name, CATALOGUE)
        _claim_authorship(home, *self.CATALOGUE_NAMES)
        report = ingest_hermes_skills(repo, home=home)
        assert "out of this repository's scope" in report.reason
        assert "does not track" in report.describe()


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
        assert pending == []
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


class TestAdoption:
    """What the loop keeps, it files in the repository — and in no palette.

    The step this replaces was pure transcription: open the candidate, copy the
    body into `skills/<pack>/`, delete the candidate. The reason it is safe to
    automate is not that the prose is trusted — it is that
    `.workpilot/skills.toml` is a want-list, so a pack nobody listed is
    rejected at the `pack-pin` gate and reaches no harness. The tests below are
    about that boundary and about the two things a person does afterwards that
    the loop must never undo.
    """

    def _learned(self, repo: Path, name: str) -> Path:
        return repo / "skills" / ADOPTED_PACK / name / "SKILL.md"

    def _authored(
        self, home: Path, name: str, body: str = "Open the log with `read_file`."
    ) -> None:
        _skill(home, "", name)
        path = home / "skills" / name / "SKILL.md"
        path.write_text(
            f"---\nname: {name}\ndescription: A learned procedure.\n---\n\n{body}\n",
            encoding="utf-8",
        )
        _claim_authorship(home, name)

    def test_a_triaged_candidate_is_written_into_the_pack(self, repo, home):
        self._authored(home, "diagnose-the-flake")
        report = ingest_hermes_skills(repo, home=home, surface="build")

        assert [p.parent.name for p in report.adopted] == ["diagnose-the-flake"]
        assert self._learned(repo, "diagnose-the-flake").is_file()
        # The queue keeps its copy, and that is deliberate: it is the live
        # mirror of what hermes has on this machine, refreshed when hermes
        # edits its own skill, while the adopted file is the snapshot this
        # project took and never rewrites.
        assert [p.name for p in report.written] == ["hermes--diagnose-the-flake.md"]

    def test_the_pack_manifest_is_valid_or_every_build_breaks(self, repo, home):
        """`packs.load_pack` raises `PackError` on a malformed manifest, and
        that is fatal to the whole registry — not only to this pack."""
        from skills_registry.packs import load_pack

        self._authored(home, "diagnose-the-flake")
        ingest_hermes_skills(repo, home=home)

        pack = load_pack(repo / "skills" / ADOPTED_PACK)
        assert pack.name == ADOPTED_PACK
        assert [s.name for s in pack.skills()] == ["diagnose-the-flake"]

    def test_the_pack_reaches_no_harness_until_a_project_lists_it(self, repo, home):
        """The whole safety argument, asserted against the real resolver."""
        from skills_registry.packs import load_pack
        from skills_registry.project import ProjectConfig
        from skills_registry.resolver import resolve

        self._authored(home, "diagnose-the-flake")
        ingest_hermes_skills(repo, home=home)
        pack = load_pack(repo / "skills" / ADOPTED_PACK)

        # A project that lists other packs, as this repository does.
        listed = resolve([pack], ProjectConfig(project_dir=repo, packs={"comms": "^1"}))
        assert listed.selected == []
        assert [r.gate for r in listed.rejected] == ["pack-pin"]

        # And what changes when somebody decides otherwise: one line.
        opted_in = resolve(
            [pack], ProjectConfig(project_dir=repo, packs={ADOPTED_PACK: "latest"})
        )
        assert [s.name for s in opted_in.selected] == ["diagnose-the-flake"]

    def test_the_adopted_file_says_it_was_not_rewritten(self, repo, home):
        """Adopting properly is a rewrite; a loop cannot do one. It says so."""
        self._authored(home, "diagnose-the-flake")
        ingest_hermes_skills(repo, home=home)

        text = self._learned(repo, "diagnose-the-flake").read_text(encoding="utf-8")
        assert "adopted: verbatim" in text
        assert "## Portability" in text
        assert "| `read_file` | Read |" in text

    def test_a_hand_rewritten_adoption_survives_every_later_build(self, repo, home):
        """The portability pass is the point of adopting. A refresh from hermes
        would throw it away on the next build."""
        self._authored(home, "diagnose-the-flake")
        ingest_hermes_skills(repo, home=home)

        mine = self._learned(repo, "diagnose-the-flake")
        mine.write_text(
            "---\nname: diagnose-the-flake\ndescription: Rewritten by hand.\n---\n\n"
            "Run it ten times before reading anything.\n",
            encoding="utf-8",
        )
        ingest_hermes_skills(repo, home=home)
        assert "Rewritten by hand." in mine.read_text(encoding="utf-8")

    def test_deleting_an_adoption_is_how_you_say_no(self, repo, home):
        """Without a ledger the next build re-adopts it, and the person deletes
        it again, for ever."""
        import shutil

        self._authored(home, "diagnose-the-flake")
        ingest_hermes_skills(repo, home=home)
        shutil.rmtree(self._learned(repo, "diagnose-the-flake").parent)

        report = ingest_hermes_skills(repo, home=home)

        assert not self._learned(repo, "diagnose-the-flake").exists()
        assert report.adopted == []
        assert report.already_adopted == 1
        assert "diagnose-the-flake" in ledger_names(repo)

    def test_an_adopted_name_stops_being_work_to_read(self, repo, home):
        """The queue file stays — it is the mirror — but nobody is asked about
        it again. A list that keeps showing settled names is the chore this
        exists to remove."""
        self._authored(home, "diagnose-the-flake")
        ingest_hermes_skills(repo, home=home)

        queued = repo / "skills" / "_proposed" / "hermes--diagnose-the-flake.md"
        assert queued.is_file()
        assert queue_state(repo) == ([], 0)

    def test_the_switch_falls_back_to_the_queue(self, repo, home, monkeypatch):
        monkeypatch.setenv("HERMES_AUTO_ADOPT", "0")
        self._authored(home, "diagnose-the-flake")
        report = ingest_hermes_skills(repo, home=home)

        assert report.adopted == []
        assert [p.name for p in report.written] == ["hermes--diagnose-the-flake.md"]
        assert not (repo / "skills" / ADOPTED_PACK).exists()

    def test_the_loops_own_pack_is_not_a_decision_about_a_name(self, repo, home):
        """Counting `hermes-learned` as provided would make the loop mask its
        own inputs: the candidate stops being reported as "already pending" and
        starts being reported as something a person decided, which nobody did.
        The ledger is what stops a second adoption."""
        self._authored(home, "diagnose-the-flake")
        ingest_hermes_skills(repo, home=home)

        assert "diagnose-the-flake" not in read_scope(repo).provided
        second = ingest_hermes_skills(repo, home=home)
        assert second.dropped == {}
        assert second.unchanged == 1
        assert second.already_adopted == 1

    def test_only_an_explicit_off_turns_it_off(self):
        """A typo must not silently disable a feature the user believes is on."""
        assert adoption_enabled({})
        assert adoption_enabled({"HERMES_AUTO_ADOPT": "yes"})
        assert adoption_enabled({"HERMES_AUTO_ADOPT": "maybe"})
        assert not adoption_enabled({"HERMES_AUTO_ADOPT": "off"})

    def test_a_dry_run_adopts_nothing(self, repo, home):
        self._authored(home, "diagnose-the-flake")
        report = ingest_hermes_skills(repo, home=home, write=False)
        assert len(report.adopted) == 1
        assert not (repo / "skills" / ADOPTED_PACK).exists()

    def test_the_cap_counts_adoptions_too(self, repo, home):
        """A pull request of two hundred files is the flood in another
        directory."""
        for i in range(5):
            self._authored(home, f"learned-{i}")
        report = ingest_hermes_skills(repo, home=home, limit=2)
        assert len(report.adopted) == 2
        assert report.deferred == 3

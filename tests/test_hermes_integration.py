"""Tests for the hermes-agent integration.

Three claims the integration rests on, each of which would be a defect if it
were wrong:

* hermes reads the output this repo already builds, so it is declared as a
  harness that **emits nothing** — a `.hermes/skills/` mirror would duplicate
  every skill to say the same thing twice;
* a skill hermes authored becomes a *candidate* and is promoted by nothing, and
  in particular carries no external verification signal — hermes's own approval
  gate is an opinion about a text, not an observation of a build;
* two packs offering the same skill name is reported, not resolved by
  whichever happened to be iterated last.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from learning_loop.hermes_ingest import (  # noqa: E402
    discover_authored_skills,
    hermes_home,
    ingest_hermes_skills,
)
from skills_registry.harnesses import load_harnesses  # noqa: E402
from skills_registry.packs import load_pack  # noqa: E402


def write_skill(
    root: Path, category: str, name: str, body: str, description: str = "d"
) -> Path:
    path = root / category / name / "SKILL.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        f"---\nname: {name}\ndescription: {description}\n"
        f"metadata:\n  hermes:\n    category: {category}\n---\n\n{body}\n",
        encoding="utf-8",
    )
    return path


@pytest.fixture
def home(tmp_path: Path) -> Path:
    """A hermes home, kept out of the repo tmp_path so the two never overlap."""
    root = tmp_path / "hermes-home"
    (root / "skills").mkdir(parents=True)
    return root


class TestTheHarnessEntry:
    def test_hermes_reads_the_output_that_already_exists(self):
        matrix = load_harnesses(REPO_ROOT)
        assert "hermes" in matrix
        hermes = matrix["hermes"]
        # The agnostic path, so `skills-cli build` emits nothing extra for it.
        assert hermes.skills_path == matrix["agnostic"].skills_path
        assert hermes.instruction_file == "AGENTS.md"

    def test_it_is_not_a_default_target(self):
        assert load_harnesses(REPO_ROOT)["hermes"].default is False

    def test_it_declares_no_private_output_paths(self):
        """A `.hermes/` mirror would be 390 files saying what is already said."""
        hermes = load_harnesses(REPO_ROOT)["hermes"]
        assert hermes.agents_path is None
        assert hermes.commands_path is None
        assert hermes.hooks is None
        assert hermes.mcp is None

    def test_the_trust_gate_is_written_down(self):
        note = load_harnesses(REPO_ROOT)["hermes"].note
        assert "hermes skills trust" in note
        assert "trusted_project_dirs" in note


class TestThePack:
    def test_the_manifest_loads(self):
        pack = load_pack(REPO_ROOT / "skills" / "hermes")
        assert pack.name == "hermes"
        assert pack.source == "NousResearch/hermes-agent"

    def test_vendoring_is_scoped_not_wholesale(self):
        """hermes-agent is a product that ships skills, not a skill collection.

        Vendoring the repository would put smart-home and social-media
        procedures into a build pipeline's command palette.
        """
        command = load_pack(REPO_ROOT / "skills" / "hermes").bootstrap["command"]
        assert "--subdir" in command
        subdirs = [command[i + 1] for i, a in enumerate(command) if a == "--subdir"]
        assert subdirs
        assert all(s.startswith("skills/") for s in subdirs)

    def test_skills_another_tracked_pack_already_provides_are_excluded(self):
        command = load_pack(REPO_ROOT / "skills" / "hermes").bootstrap["command"]
        excluded = {command[i + 1] for i, a in enumerate(command) if a == "--exclude"}
        # Upstream's own adaptation of the pack this repo already tracks.
        assert "test-driven-development" in excluded

    def test_it_is_opt_in(self):
        assert load_pack(REPO_ROOT / "skills" / "hermes").bootstrap["optional"] is True


class TestDiscovery:
    def test_an_absent_hermes_is_not_an_error(self, tmp_path):
        report = ingest_hermes_skills(tmp_path, home=tmp_path / "nope")
        assert report.found == 0
        assert "not installed" in report.reason

    def test_authored_skills_are_found(self, home):
        write_skill(home / "skills", "devops", "rotate-creds", "Rotate them.")
        found = discover_authored_skills(home)
        assert [c.name for c in found] == ["rotate-creds"]
        assert found[0].category == "devops"
        assert found[0].staged is False

    def test_the_approval_queue_counts_too(self, home):
        write_skill(home / "pending" / "skills", "devops", "staged-one", "Body.")
        found = discover_authored_skills(home)
        assert [c.staged for c in found] == [True]

    def test_bundled_skills_are_not_experience(self, home):
        """They are what hermes shipped with, not what it learned."""
        write_skill(home / "skills", "devops", "shipped", "Upstream body.")
        write_skill(home / "skills", "devops", "learned", "Learned body.")
        (home / "skills" / ".bundled_manifest").write_text(
            json.dumps({"devops/shipped": "abc123"}), encoding="utf-8"
        )
        assert [c.name for c in discover_authored_skills(home)] == ["learned"]

    def test_hub_metadata_is_skipped(self, home):
        write_skill(home / "skills", ".hub", "not-a-skill", "Metadata.")
        assert discover_authored_skills(home) == []

    def test_an_empty_skill_is_not_a_candidate(self, home):
        path = home / "skills" / "devops" / "hollow" / "SKILL.md"
        path.parent.mkdir(parents=True)
        path.write_text("---\nname: hollow\ndescription: d\n---\n\n", encoding="utf-8")
        assert discover_authored_skills(home) == []


class TestIngest:
    def test_a_candidate_lands_in_the_review_queue(self, home, tmp_path):
        repo = tmp_path / "repo"
        write_skill(home / "skills", "devops", "rotate-creds", "Rotate them.")
        report = ingest_hermes_skills(repo, home=home)

        assert len(report.written) == 1
        written = report.written[0]
        assert written.parent == repo / "skills" / "_proposed"
        assert written.name == "hermes--rotate-creds.md"
        assert "Rotate them." in written.read_text(encoding="utf-8")

    def test_it_carries_no_external_signal(self, home, tmp_path):
        """The claim the promotion rules depend on.

        Hermes's approval gate is a person saying yes to a text. It is not an
        observation of a build that used the skill, so counting it as
        corroboration would manufacture the evidence `evaluate` refuses to
        invent.
        """
        repo = tmp_path / "repo"
        write_skill(home / "skills", "devops", "rotate-creds", "Rotate them.")
        body = (
            ingest_hermes_skills(repo, home=home).written[0].read_text(encoding="utf-8")
        )
        for signal in ("tests_passed", "qa_clean", "detector_clean", "pr_merged"):
            assert signal not in body
        assert "NO external verification signal" in body

    def test_it_never_touches_a_real_pack(self, home, tmp_path):
        repo = tmp_path / "repo"
        (repo / "skills" / "superpowers").mkdir(parents=True)
        marker = repo / "skills" / "superpowers" / "pack.json"
        marker.write_text('{"name":"superpowers","version":"1.0.0"}', encoding="utf-8")
        before = marker.read_text(encoding="utf-8")

        write_skill(home / "skills", "devops", "rotate-creds", "Rotate them.")
        ingest_hermes_skills(repo, home=home)

        assert marker.read_text(encoding="utf-8") == before
        assert [p.name for p in (repo / "skills").iterdir()] != []

    def test_it_never_writes_into_the_hermes_home(self, home, tmp_path):
        write_skill(home / "skills", "devops", "rotate-creds", "Rotate them.")
        before = sorted(p.relative_to(home).as_posix() for p in home.rglob("*"))
        ingest_hermes_skills(tmp_path / "repo", home=home)
        after = sorted(p.relative_to(home).as_posix() for p in home.rglob("*"))
        assert before == after

    def test_unchanged_candidates_are_not_re_proposed(self, home, tmp_path):
        """Re-proposing the same thing every build turns review into noise."""
        repo = tmp_path / "repo"
        write_skill(home / "skills", "devops", "rotate-creds", "Rotate them.")
        first = ingest_hermes_skills(repo, home=home)
        second = ingest_hermes_skills(repo, home=home)
        assert len(first.written) == 1
        assert second.written == []
        assert second.unchanged == 1

    def test_an_edited_skill_refreshes_its_candidate(self, home, tmp_path):
        repo = tmp_path / "repo"
        write_skill(home / "skills", "devops", "rotate-creds", "Rotate them.")
        ingest_hermes_skills(repo, home=home)
        write_skill(home / "skills", "devops", "rotate-creds", "Rotate them twice.")
        again = ingest_hermes_skills(repo, home=home)
        assert len(again.written) == 1
        assert "twice" in again.written[0].read_text(encoding="utf-8")

    def test_the_per_run_cap_defers_rather_than_floods(self, home, tmp_path):
        repo = tmp_path / "repo"
        for i in range(5):
            write_skill(home / "skills", "devops", f"skill-{i}", f"Body {i}.")
        report = ingest_hermes_skills(repo, home=home, limit=2)
        assert len(report.written) == 2
        assert report.deferred == 3

    def test_dry_run_writes_nothing(self, home, tmp_path):
        repo = tmp_path / "repo"
        write_skill(home / "skills", "devops", "rotate-creds", "Rotate them.")
        report = ingest_hermes_skills(repo, home=home, write=False)
        assert len(report.written) == 1
        assert not report.written[0].exists()


class TestHermesHome:
    def test_the_env_override_wins(self, monkeypatch, tmp_path):
        monkeypatch.setenv("HERMES_HOME", str(tmp_path / "elsewhere"))
        assert hermes_home() == tmp_path / "elsewhere"

    def test_the_default_is_the_documented_one(self, monkeypatch):
        monkeypatch.delenv("HERMES_HOME", raising=False)
        if sys.platform != "win32":
            assert hermes_home() == Path.home() / ".hermes"


class TestNameCollision:
    """The gate adding a fifth pack required.

    The build keys its output on the skill name — `.agents/skills/<name>/` —
    so two packs providing the same name used to produce one file whose
    content depended on which pack was iterated last. Survivable while the
    tracked upstreams happened not to overlap; not survivable now, since
    several of them are adaptations of each other and share names on purpose.
    """

    def _pack(self, root: Path, name: str, skill: str, body: str) -> None:
        pack_dir = root / name
        (pack_dir / skill).mkdir(parents=True)
        (pack_dir / "pack.json").write_text(
            json.dumps({"name": name, "version": "1.0.0"}), encoding="utf-8"
        )
        (pack_dir / skill / "SKILL.md").write_text(
            f"---\nname: {skill}\ndescription: d\n---\n\n{body}\n", encoding="utf-8"
        )

    def _resolve(self, tmp_path: Path, packs_pin: dict[str, str] | None = None):
        from skills_registry.packs import load_packs
        from skills_registry.project import ProjectConfig
        from skills_registry.resolver import resolve

        root = tmp_path / "skills"
        root.mkdir(exist_ok=True)
        config = ProjectConfig(project_dir=tmp_path, packs=packs_pin or {})
        return resolve(load_packs(root), config)

    def test_a_duplicate_name_is_reported_not_silently_overwritten(self, tmp_path):
        root = tmp_path / "skills"
        root.mkdir()
        self._pack(root, "superpowers", "test-driven-development", "The original.")
        self._pack(root, "hermes", "test-driven-development", "The adaptation.")

        resolution = self._resolve(tmp_path)
        emitted = [
            s for s in resolution.selected if s.name == "test-driven-development"
        ]
        assert len(emitted) == 1

        collisions = [r for r in resolution.rejected if r.gate == "name-collision"]
        assert len(collisions) == 1
        assert emitted[0].pack != collisions[0].pack
        assert emitted[0].pack in collisions[0].reason

    def test_the_project_decides_which_pack_wins(self, tmp_path):
        root = tmp_path / "skills"
        root.mkdir()
        self._pack(root, "superpowers", "test-driven-development", "The original.")
        self._pack(root, "hermes", "test-driven-development", "The adaptation.")

        # `[packs]` is written by hand, so its order is a statement of
        # preference — not an accident of alphabetical iteration.
        first = self._resolve(tmp_path, {"hermes": "latest", "superpowers": "latest"})
        assert first.by_name()["test-driven-development"].pack == "hermes"

        second = self._resolve(tmp_path, {"superpowers": "latest", "hermes": "latest"})
        assert second.by_name()["test-driven-development"].pack == "superpowers"

    def test_distinct_names_never_collide(self, tmp_path):
        root = tmp_path / "skills"
        root.mkdir()
        self._pack(root, "superpowers", "brainstorming", "One.")
        self._pack(root, "hermes", "systematic-debugging", "Two.")
        resolution = self._resolve(tmp_path)
        assert len(resolution.selected) == 2
        assert not [r for r in resolution.rejected if r.gate == "name-collision"]

    def test_why_can_explain_the_disappearance(self, tmp_path):
        root = tmp_path / "skills"
        root.mkdir()
        self._pack(root, "superpowers", "test-driven-development", "The original.")
        self._pack(root, "hermes", "test-driven-development", "The adaptation.")
        resolution = self._resolve(tmp_path)
        reasons = resolution.rejections_for("test-driven-development")
        assert reasons
        assert "already provides" in reasons[0].reason

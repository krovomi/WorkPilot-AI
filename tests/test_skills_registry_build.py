"""Tests for materialising skills into harness outputs.

Three properties matter more than the rest:

* **Reproducible** — two machines must produce byte-identical output, or the
  CI `skills:check` gate fires on the path separator rather than on real drift.
* **Bounded ownership** — the build removes only what it emitted last time.
  `.agents/skills/` currently also holds 76 hand-committed BMAD directories; a
  generator that owned the whole directory would delete them on first run.
* **Idempotent** — a second build writes nothing.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from skills_registry.build import apply_build, content_hash, plan_build  # noqa: E402
from skills_registry.frontmatter import parse_frontmatter, workpilot_meta  # noqa: E402
from skills_registry.packs import load_packs  # noqa: E402
from skills_registry.project import ProjectConfig  # noqa: E402
from skills_registry.resolver import resolve  # noqa: E402


@pytest.fixture
def source(tmp_path: Path) -> Path:
    """A miniature source repo: one pack, one skill with a bundled resource."""
    root = tmp_path / "src"
    (root / "capabilities").mkdir(parents=True)
    (root / "capabilities" / "harnesses.yaml").write_text(
        "agnostic:\n"
        "  skills_path: .agents/skills\n"
        "  agents_path: .agents/agents\n"
        "  commands_path: null\n"
        "  format: skill-dir\n"
        "  default: true\n"
        "gemini:\n"
        "  skills_path: .agents/skills\n"
        "  agents_path: null\n"
        "  commands_path: .gemini/commands\n"
        "  format: toml-command\n"
        "  default: false\n",
        encoding="utf-8",
    )
    pack = root / "skills" / "demo"
    (pack / "hello").mkdir(parents=True)
    (pack / "pack.json").write_text(
        json.dumps({"name": "demo", "version": "1.4.2", "targets": {}}),
        encoding="utf-8",
    )
    (pack / "hello" / "SKILL.md").write_text(
        "---\nname: hello\ndescription: says hello\n---\n\nSay hello.\n",
        encoding="utf-8",
    )
    (pack / "hello" / "reference.md").write_text("deep detail\n", encoding="utf-8")
    (pack / "agents").mkdir()
    (pack / "agents" / "greeter.md").write_text(
        "---\nname: greeter\ndescription: greets\n---\n\nGreet.\n", encoding="utf-8"
    )
    return root


def build(source: Path, out: Path, harnesses=("agnostic",), check_only=False):
    packs = load_packs(source / "skills")
    config = ProjectConfig(project_dir=out, targets={}, packs={})
    resolution = resolve(packs, config)
    plan = plan_build(source, resolution, list(harnesses))
    return apply_build(
        out,
        resolution,
        plan,
        list(harnesses),
        source_root=source,
        check_only=check_only,
    )


class TestOutputs:
    def test_emits_skill_agent_bundled_resource_and_lockfile(self, source, tmp_path):
        out = tmp_path / "out"
        build(source, out)
        assert (out / ".agents/skills/hello/SKILL.md").is_file()
        assert (
            out / ".agents/skills/hello/reference.md"
        ).read_text() == "deep detail\n"
        assert (out / ".agents/agents/greeter.md").is_file()
        assert (out / "skills-lock.json").is_file()

    def test_injects_derived_provenance_into_frontmatter(self, source, tmp_path):
        out = tmp_path / "out"
        build(source, out)
        meta, body = parse_frontmatter(
            (out / ".agents/skills/hello/SKILL.md").read_text(encoding="utf-8")
        )
        wp = workpilot_meta(meta)
        assert wp["pack"] == "demo"
        assert wp["version"] == "1.4.2"
        assert len(wp["content_sha256"]) == 64
        assert meta["name"] == "hello" and meta["description"] == "says hello"
        assert body.strip() == "Say hello."

    def test_body_carries_no_generator_preamble(self, source, tmp_path):
        """The note is for humans; in the body it would cost tokens on every run."""
        out = tmp_path / "out"
        build(source, out)
        _, body = parse_frontmatter(
            (out / ".agents/skills/hello/SKILL.md").read_text(encoding="utf-8")
        )
        assert not body.lstrip().startswith("<!--")

    def test_gemini_harness_emits_toml_commands(self, source, tmp_path):
        out = tmp_path / "out"
        build(source, out, harnesses=("agnostic", "gemini"))
        toml = (out / ".gemini/commands/hello.toml").read_text(encoding="utf-8")
        assert 'description = "says hello"' in toml
        assert "Say hello." in toml

    def test_lockfile_records_provenance_and_rejections(self, source, tmp_path):
        out = tmp_path / "out"
        build(source, out)
        lock = json.loads((out / "skills-lock.json").read_text(encoding="utf-8"))
        assert lock["packs"]["demo"]["version"] == "1.4.2"
        assert lock["skills"]["hello"]["source"] == "skills/demo/hello/SKILL.md"
        assert len(lock["skills"]["hello"]["contentSha256"]) == 64
        assert ".agents/skills/hello/SKILL.md" in lock["emitted"]


class TestReproducibility:
    def test_no_absolute_paths_leak_into_the_output(self, source, tmp_path):
        # An absolute path would make `skills:check` fail on CI purely because
        # the checkout lives somewhere else.
        out = tmp_path / "out"
        build(source, out)
        for f in out.rglob("*"):
            if f.is_file() and f.suffix in (".md", ".json", ".toml"):
                text = f.read_text(encoding="utf-8")
                assert str(tmp_path) not in text, f"{f} leaks an absolute path"

    def test_same_source_two_destinations_gives_identical_documents(
        self, source, tmp_path
    ):
        a, b = tmp_path / "a", tmp_path / "b"
        build(source, a)
        build(source, b)
        assert (a / ".agents/skills/hello/SKILL.md").read_text() == (
            b / ".agents/skills/hello/SKILL.md"
        ).read_text()

    def test_content_hash_covers_bundled_resources(self, source, tmp_path):
        packs = load_packs(source / "skills")
        skill = next(s for s in packs[0].skills() if s.name == "hello")
        before = content_hash(skill)
        (source / "skills/demo/hello/reference.md").write_text(
            "changed\n", encoding="utf-8"
        )
        after = content_hash(
            next(
                s
                for s in load_packs(source / "skills")[0].skills()
                if s.name == "hello"
            )
        )
        assert before != after, "a change to a bundled file must move the hash"


class TestIdempotenceAndOwnership:
    def test_second_build_writes_nothing(self, source, tmp_path):
        out = tmp_path / "out"
        build(source, out)
        second = build(source, out)
        assert not second.changed
        assert second.written == [] and second.removed == []

    def test_check_mode_passes_on_fresh_output_and_writes_nothing(
        self, source, tmp_path
    ):
        out = tmp_path / "out"
        build(source, out)
        result = build(source, out, check_only=True)
        assert not result.changed

    def test_check_mode_detects_a_hand_edit(self, source, tmp_path):
        out = tmp_path / "out"
        build(source, out)
        target = out / ".agents/skills/hello/SKILL.md"
        original = target.read_text(encoding="utf-8")
        target.write_text(original + "\nsomeone edited the output\n", encoding="utf-8")
        result = build(source, out, check_only=True)
        assert result.changed
        # check mode must not repair it -- reporting is its whole job
        assert "someone edited" in target.read_text(encoding="utf-8")

    def test_files_the_build_never_emitted_are_left_alone(self, source, tmp_path):
        """The 76 hand-committed BMAD directories depend on this."""
        out = tmp_path / "out"
        build(source, out)
        foreign = out / ".agents/skills/hand-written/SKILL.md"
        foreign.parent.mkdir(parents=True)
        foreign.write_text("---\nname: hand-written\n---\nbody\n", encoding="utf-8")
        build(source, out)
        assert foreign.is_file(), "the build deleted a file it never owned"

    def test_a_skill_that_stops_resolving_is_removed(self, source, tmp_path):
        out = tmp_path / "out"
        build(source, out)
        emitted = out / ".agents/skills/hello/SKILL.md"
        assert emitted.is_file()
        # Make the skill inapplicable to this project.
        (source / "skills/demo/pack.json").write_text(
            json.dumps(
                {"name": "demo", "version": "1.4.2", "targets": {"dotnet": ">=99"}}
            ),
            encoding="utf-8",
        )
        result = build(source, out)
        assert not emitted.exists()
        assert Path(".agents/skills/hello/SKILL.md") in result.removed

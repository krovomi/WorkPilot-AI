"""The memory bridge on what the main tests do not hand it.

That covers four kinds of input:

* a memory file with an unclosed frontmatter or a comment over several lines;
* a rule an agent proposed and a person then confirmed;
* a second ingest of an agent the brain already knows;
* a bridge file that already carries a backup, or an agent with no file to bridge.

The notes and the vault get the same treatment: tags written as one value, a
write that fails half way, a recall that falls back to the word index.
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path

import pytest
from brain import Brain, memories
from brain.memories import (
    BRIDGE_START,
    bridge,
    discover,
    extract_instructions,
    ingest,
    instructions,
    refresh_bridges,
    remember,
)
from brain.notes import Note, read_note, write_note

needs_git = pytest.mark.skipif(
    shutil.which("git") is None, reason="git is not installed"
)


@pytest.fixture(autouse=True)
def _home(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("WORKPILOT_BRAIN_HOME", str(home))
    monkeypatch.setenv("HERMES_HOME", str(home / ".hermes"))
    monkeypatch.setenv("BRAIN_PULL_INTERVAL", "0")
    monkeypatch.delenv("WORKPILOT_BRAIN_DIR", raising=False)
    monkeypatch.delenv("BRAIN_SIMILARITY", raising=False)
    return home


def _memory(home: Path, rel: str, text: str) -> Path:
    path = home / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


class TestSimilarityThreshold:
    @pytest.mark.parametrize(
        ("value", "expected"),
        [("not a number", 0.72), ("5", 1.0), ("0.1", 0.3), ("0.8", 0.8)],
    )
    def test_the_setting_is_read_and_kept_in_range(self, monkeypatch, value, expected):
        monkeypatch.setenv("BRAIN_SIMILARITY", value)

        assert memories._threshold() == expected


class TestExtract:
    def test_an_unclosed_frontmatter_is_read_as_text(self):
        text = "---\n- Toujours écrire les tests en premier\n"

        assert extract_instructions(text) == ["Toujours écrire les tests en premier"]

    def test_a_comment_over_several_lines_is_not_a_rule(self):
        text = (
            "<!-- notes for myself\n"
            "- this line is inside the comment\n"
            "end of the comment -->\n"
            "- Garder les commits petits et lisibles\n"
        )

        assert extract_instructions(text) == ["Garder les commits petits et lisibles"]

    def test_too_short_and_too_long_lines_are_not_rules(self):
        text = f"- court\n- {'mot ' * 200}\n- Une règle de longueur normale\n"

        assert extract_instructions(text) == ["Une règle de longueur normale"]


class TestInstructions:
    def test_a_note_that_cannot_be_read_is_left_out(self, tmp_path, monkeypatch):
        root = tmp_path / "brain"
        remember(root, "Toujours répondre en français")
        remember(root, "Documenter chaque endpoint public")
        real = memories.read_note

        def busy(root_, rel):
            if "documenter" in str(rel):
                raise OSError("locked")
            return real(root_, rel)

        monkeypatch.setattr(memories, "read_note", busy)

        assert [i.text for i in instructions(root)] == ["Toujours répondre en français"]

    def test_agents_written_as_one_value(self, tmp_path):
        root = tmp_path / "brain"
        write_note(
            root,
            Note(
                path=Path("instructions/one.md"),
                meta={"kind": "instruction", "agents": "codex"},
                body="Toujours répondre en français\n",
            ),
        )

        assert instructions(root)[0].agents == ["codex"]


class TestRemember:
    def test_an_unknown_status_is_refused(self, tmp_path):
        with pytest.raises(ValueError, match="unknown instruction status 'retired'"):
            remember(tmp_path, "Toujours répondre en français", status="retired")

    def test_an_empty_instruction_is_refused(self, tmp_path):
        with pytest.raises(ValueError, match="cannot be empty"):
            remember(tmp_path, " \n\t ")

    def test_a_person_confirms_what_an_agent_proposed(self, tmp_path):
        root = tmp_path / "brain"
        proposed = remember(
            root, "Toujours répondre en français", agent_name="coder", status="proposed"
        )
        assert instructions(root) == []

        confirmed = remember(root, "Toujours répondre en français", agent_name="coder")

        assert (confirmed.outcome, confirmed.rel) == ("reinforced", proposed.rel)
        [only] = instructions(root)
        assert only.status == "active"

    def test_a_proposal_does_not_reactivate_a_rule(self, tmp_path):
        root = tmp_path / "brain"
        rel = remember(root, "Toujours répondre en français").rel
        note = read_note(root, rel)
        note.meta["status"] = "retired"
        write_note(root, note)

        again = remember(
            root, "Toujours répondre en français", agent_name="coder", status="proposed"
        )

        assert again.outcome == "reinforced"
        assert read_note(root, rel).meta["status"] == "retired"

    def test_another_wording_is_kept_beside_the_rule_not_in_it(self, tmp_path):
        root = tmp_path / "brain"
        rel = remember(root, "Toujours répondre en français", agent_name="codex").rel

        result = remember(
            root, "Réponds toujours en français à l'utilisateur", agent_name="codex"
        )

        assert result.outcome == "reinforced" and result.similarity < 1
        body = read_note(root, rel).body
        assert (
            "## Formulation de codex\n\n> Réponds toujours en français à l'utilisateur"
            in body
        )
        assert instructions(root)[0].text == "Toujours répondre en français"
        assert (
            remember(
                root, "Réponds toujours en français à l'utilisateur", agent_name="codex"
            ).outcome
            == "known"
        )


class TestDiscoverAndIngest:
    def test_only_the_agents_asked_for_are_listed(self, _home):
        _memory(_home, ".codex/AGENTS.md", "- Toujours répondre en français\n")

        found = discover(names=["codex"])

        assert [(f.agent, f.exists, f.instructions) for f in found] == [
            ("codex", True, 1)
        ]

    def test_a_second_ingest_keeps_the_agent_page_a_person_edited(
        self, tmp_path, _home
    ):
        root = tmp_path / "brain"
        _memory(_home, ".codex/AGENTS.md", "- Toujours répondre en français\n")
        ingest(root, names=["codex"])
        page = root / "agents" / "codex.md"
        page.write_text("# Codex\n\nMon agent pour le backend.\n", encoding="utf-8")

        report = ingest(root, names=["codex"])

        assert report.known == 1
        assert (
            page.read_text(encoding="utf-8")
            == "# Codex\n\nMon agent pour le backend.\n"
        )


class TestBridge:
    def test_an_agent_without_a_memory_file_of_its_own(self, tmp_path):
        assert bridge(tmp_path, "cursor").to_dict() == {
            "agent": "cursor",
            "path": None,
            "action": "unsupported",
            "preview": "",
            "backup": None,
        }

    def test_a_rule_only_this_agent_holds_is_not_repeated_to_it(self, tmp_path, _home):
        root = tmp_path / "brain"
        remember(root, "Toujours répondre en français", agent_name="codex")
        remember(root, "Documenter chaque endpoint public", agent_name="claude-code")
        _memory(_home, ".codex/AGENTS.md", "- Toujours répondre en français\n")

        block = bridge(root, "codex").preview

        assert "Documenter chaque endpoint public" in block
        assert "français" not in block
        assert "Déjà dans ta mémoire" not in block

    def test_the_first_backup_is_the_one_kept(self, tmp_path, _home):
        root = tmp_path / "brain"
        remember(root, "Documenter chaque endpoint public", agent_name="claude-code")
        memory = _memory(_home, ".codex/AGENTS.md", "- Ma toute première règle\n")
        first = bridge(root, "codex", apply=True)
        # The person takes the block out and writes their file again.
        memory.write_text("- Une règle écrite plus tard\n", encoding="utf-8")

        second = bridge(root, "codex", apply=True)

        assert second.action == "written" and second.backup == first.backup
        assert (
            Path(first.backup).read_text(encoding="utf-8")
            == "- Ma toute première règle\n"
        )
        assert memory.read_text(encoding="utf-8").startswith(
            "- Une règle écrite plus tard\n"
        )

    def test_a_refresh_rewrites_the_block_with_the_new_rules(self, tmp_path, _home):
        root = tmp_path / "brain"
        remember(root, "Documenter chaque endpoint public", agent_name="claude-code")
        memory = _memory(_home, ".codex/AGENTS.md", "- Ma règle\n")
        bridge(root, "codex", apply=True)
        remember(
            root, "Garder les commits petits et lisibles", agent_name="claude-code"
        )

        [result] = refresh_bridges(root)

        assert (result.agent, result.action) == ("codex", "written")
        text = memory.read_text(encoding="utf-8")
        assert text.count(BRIDGE_START) == 1
        assert "Garder les commits petits et lisibles" in text


class TestNotes:
    @pytest.mark.parametrize(
        ("raw", "expected"),
        [("jwt, #Auth, ", ["jwt", "auth"]), (2026, ["2026"])],
    )
    def test_tags_written_as_one_value(self, raw, expected):
        note = Note(path=Path("knowledge/a.md"), meta={"tags": raw}, body="x\n")

        assert note.tags == expected

    def test_a_write_that_fails_leaves_the_old_note_and_no_temporary_file(
        self, tmp_path, monkeypatch
    ):
        write_note(tmp_path, Note(path=Path("knowledge/a.md"), meta={}, body="old\n"))

        def full(src, dst):
            raise OSError("disk full")

        monkeypatch.setattr(os, "replace", full)

        with pytest.raises(OSError, match="disk full"):
            write_note(
                tmp_path, Note(path=Path("knowledge/a.md"), meta={}, body="new\n")
            )

        assert read_note(tmp_path, "knowledge/a.md").body.strip() == "old"
        assert sorted(p.name for p in (tmp_path / "knowledge").iterdir()) == ["a.md"]


@needs_git
class TestVault:
    @pytest.fixture
    def brain(self, tmp_path, monkeypatch):
        monkeypatch.setenv("BRAIN_AUTO_PUSH", "0")
        made = Brain(tmp_path / "vault")
        made.init()
        return made

    def test_a_path_without_an_extension_becomes_a_note(self, brain):
        result = brain.write(
            "Clés JWT", "Rotation tous les 90 jours.", path="knowledge/jwt"
        )

        assert result.rel == "knowledge/jwt.md"
        assert (brain.root / "knowledge" / "jwt.md").is_file()

    def test_an_instruction_status_is_active_or_retired(self, brain):
        with pytest.raises(ValueError, match="'active' or 'retired'"):
            brain.set_instruction_status("instructions/x.md", "proposed")

    def test_a_query_without_a_word_finds_nothing(self, brain):
        assert brain.recall("?! -")["hits"] == []

    def test_the_word_index_skips_a_note_it_cannot_read_and_stops_at_the_limit(
        self, brain, monkeypatch
    ):
        for name in ("a", "b", "c"):
            brain.write(
                f"Note {name}",
                "La rotation des clés se fait chaque trimestre.",
                sync=False,
            )
        real = Path.read_text

        def locked(self, *args, **kwargs):
            if self.name == "note-a.md":
                raise PermissionError("locked")
            return real(self, *args, **kwargs)

        monkeypatch.setattr(Path, "read_text", locked)

        found = brain.recall("trimestre rotation", limit=1)

        assert found["level"] == "index"
        assert [hit["source_file"] for hit in found["hits"]] == ["knowledge/note-b.md"]
        assert found["hits"][0]["match"].startswith("La rotation")

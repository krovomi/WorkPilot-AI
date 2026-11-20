"""Architecture decision records written by hand, at their edges.

`test_docintel.py` reads the usual MADR and adr-tools records. This file reads
what a person writes when no template holds them: text before the first
heading, front matter with nested keys, a superseding record named only in
the front matter, no decision section, a record outside the project, and a
folder that cannot be listed.
"""

from __future__ import annotations

from pathlib import Path

from docintel.adr import collect_adrs, parse_adr


def write(root: Path, relative: str, text: str) -> Path:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


class TestHandWrittenRecords:
    def test_front_matter_names_the_record_that_supersedes_it(self, tmp_path):
        path = write(
            tmp_path,
            "docs/adr/0003-use-postgres.md",
            "---\n"
            "title: Use Postgres\n"
            "status: accepted\n"
            "superseded-by: ADR-0007\n"
            "tags:\n"
            "  - storage\n"
            "- loose item\n"
            "---\n"
            "Written before any heading.\n\n"
            "# Use Postgres\n\n"
            "## Context\n\nWe need a database.\n",
        )

        record = parse_adr(path, tmp_path)

        assert (record.id, record.title) == ("ADR-0003", "Use Postgres")
        assert (record.status, record.superseded_by) == ("superseded", "ADR-0007")
        assert record.decision == ""

    def test_a_long_decision_is_cut_to_its_first_paragraph(self, tmp_path):
        path = write(
            tmp_path,
            "docs/adr/0004-queue.md",
            "# 4. Queue\n\n## Decision\n\n" + "word " * 120 + "\n\nSecond paragraph.\n",
        )

        decision = parse_adr(path, tmp_path).decision

        assert decision.endswith("…") and len(decision) == 400
        assert "Second paragraph" not in decision

    def test_a_record_outside_the_project_is_named_by_its_file(self, tmp_path):
        path = write(tmp_path, "elsewhere/0001-x.md", "# X\n")

        assert parse_adr(path, tmp_path / "project").path == "0001-x.md"

    def test_a_record_that_cannot_be_read_is_skipped(self, tmp_path):
        assert parse_adr(tmp_path / "docs" / "adr" / "missing.md", tmp_path) is None


class TestCollecting:
    def test_a_folder_that_cannot_be_listed_gives_no_records(
        self, tmp_path, monkeypatch
    ):
        write(tmp_path, "docs/adr/0001-x.md", "# X\n")

        def refuse(self, _pattern):
            raise PermissionError(self)

        monkeypatch.setattr(Path, "glob", refuse)

        assert collect_adrs(tmp_path) == []

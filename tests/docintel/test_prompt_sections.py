"""The docintel prompt sections, at the edges of what they are handed.

The prompt tests elsewhere read real attachments, ADRs and captures into the
sections. This file feeds the sections what they meet less often: documents
withheld without text, a masked copy outside the task, a plain document,
diagnoses that render nothing, more blocks than one section holds, ADRs none
of which bind, proposed ones only, a long visual record, and one reader that
fails while the others still answer.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from docintel import prompt
from docintel.models import DocintelResult, ExtractedDocument
from docintel.spec_drafts import DraftSet, TableDraft, drafts_path
from docintel.tables import RuleTable
from docintel.visual_qa import VisualQaRecord, record_path


@pytest.fixture
def project(tmp_path: Path) -> Path:
    root = tmp_path / "shop"
    root.mkdir()
    return root


@pytest.fixture
def spec_dir(project: Path) -> Path:
    spec = project / ".workpilot" / "specs" / "001-orders"
    (spec / "attachments").mkdir(parents=True)
    return spec


def record(spec_dir: Path, *documents: ExtractedDocument, diagnosis=None) -> None:
    target = spec_dir / "docintel" / "result.json"
    target.parent.mkdir(exist_ok=True)
    result = DocintelResult(documents=list(documents), description_diagnosis=diagnosis)
    target.write_text(json.dumps(result.to_dict()), encoding="utf-8")


def adr(project: Path, number: int, status: str) -> None:
    path = project / "docs" / "adr" / f"{number:04d}-decision-{number}.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        f"# {number}. Decision {number}\n\n## Status\n\n{status}\n\n"
        f"## Decision\n\nWe decide {number}.\n",
        encoding="utf-8",
    )


CI = {"ci": {"errors": [{"tool": "tsc", "code": "TS2304", "message": "x"}]}}


class TestAttachments:
    def test_a_document_withheld_for_a_secret_without_text_cites_none(self, spec_dir):
        record(
            spec_dir,
            ExtractedDocument(
                path="attachments/key.png", status="withheld", secrets=["AWS key"]
            ),
        )

        section = prompt.attachments_section(spec_dir)

        assert "shows a secret that could not be masked (AWS key)" in section
        assert "Its text" not in section

    def test_a_masked_copy_outside_the_task_is_not_cited(self, spec_dir):
        record(
            spec_dir,
            ExtractedDocument(
                path="attachments/key.png",
                status="redacted",
                redacted_path="../../elsewhere.png",
                text="masked",
            ),
        )

        assert prompt.attachments_section(spec_dir) == ""

    def test_a_document_is_converted_with_the_document_skill(self, spec_dir):
        record(
            spec_dir,
            ExtractedDocument(path="attachments/spec.docx", status="document"),
            ExtractedDocument(path="attachments/odd.bin", status="skipped"),
        )

        section = prompt.attachments_section(spec_dir)

        assert "spec.docx` — document" in section
        assert "convert-documents-to-markdown" in section
        assert "odd.bin" not in section

    def test_more_attachments_than_a_section_holds_are_counted(
        self, spec_dir, monkeypatch
    ):
        record(
            spec_dir,
            *[
                ExtractedDocument(path=f"attachments/{n}.docx", status="document")
                for n in range(3)
            ],
        )
        monkeypatch.setattr(
            prompt, "MAX_SECTION_CHARS", len(prompt._ATTACHMENTS_HEADER)
        )

        section = prompt.attachments_section(spec_dir)

        assert "3 more attachment(s) are listed in" in section
        assert "0.docx" not in section


class TestDiagnostics:
    def test_a_diagnosis_that_renders_nothing_or_points_outside_is_left_out(
        self, spec_dir
    ):
        record(
            spec_dir,
            ExtractedDocument(
                path="attachments/empty.log", status="text", diagnosis={"x": 1}
            ),
            ExtractedDocument(path="../outside.log", status="text", diagnosis=CI),
            diagnosis={"x": 1},
        )

        assert prompt.diagnostics_section(spec_dir) == ""

    def test_more_diagnoses_than_a_section_holds_point_at_the_record(
        self, spec_dir, monkeypatch
    ):
        record(
            spec_dir,
            ExtractedDocument(path="attachments/ci.log", status="text", diagnosis=CI),
        )
        monkeypatch.setattr(
            prompt, "MAX_SECTION_CHARS", len(prompt._DIAGNOSTICS_HEADER)
        )

        section = prompt.diagnostics_section(spec_dir)

        assert section.endswith("More in `docintel/result.json`.")
        assert "TS2304" not in section


class TestRules:
    def test_more_tables_than_a_section_holds_point_at_the_drafts(
        self, spec_dir, monkeypatch
    ):
        table = RuleTable(headers=["Country", "Rate"], rows=[["France", "20"]])
        drafts = DraftSet(tables=[TableDraft(key="t1", table=table, source="a.md")])
        drafts_path(spec_dir).parent.mkdir(exist_ok=True)
        drafts_path(spec_dir).write_text(json.dumps(drafts.to_dict()), encoding="utf-8")
        monkeypatch.setattr(prompt, "MAX_SECTION_CHARS", len(prompt._RULES_HEADER))

        section = prompt.rules_section(spec_dir)

        assert section.endswith("More in `docintel/drafts.json`.")
        assert "France" not in section


class TestAdrs:
    def test_records_none_of_which_bind_give_no_section(self, project):
        adr(project, 1, "Rejected")
        adr(project, 2, "Deprecated")

        assert prompt.adr_section(project) == ""

    def test_proposed_records_alone_are_listed_without_accepted_ones(self, project):
        adr(project, 1, "Proposed")

        section = prompt.adr_section(project)

        assert "ADR-0001" in section and "Accepted:" not in section

    def test_accepted_records_past_the_ceiling_are_counted(self, project, monkeypatch):
        for number in (1, 2, 3):
            adr(project, number, "Accepted")
        monkeypatch.setattr(prompt, "MAX_ADRS", 2)

        section = prompt.adr_section(project)

        assert "- … 1 more in `docs/adr`" in section
        assert "ADR-0003" not in section


class TestVisualQa:
    def test_a_long_record_says_how_much_is_left_out(self, spec_dir, monkeypatch):
        findings = [
            {"severity": "low", "kind": "clipped", "text": f"Label {n}", "capture": "a"}
            for n in range(3)
        ]
        path = record_path(spec_dir)
        path.parent.mkdir(exist_ok=True)
        path.write_text(
            json.dumps(VisualQaRecord(findings=findings).to_dict()), encoding="utf-8"
        )
        monkeypatch.setattr(prompt, "MAX_VISUAL_LINES", 2)

        section = prompt.visual_qa_section(spec_dir)

        assert "… 1 more in the record" in section
        assert "Label 2" not in section


class TestTheWholeSection:
    def test_a_reader_that_fails_leaves_the_others_standing(
        self, project, spec_dir, monkeypatch, caplog
    ):
        adr(project, 1, "Accepted")
        record(
            spec_dir,
            ExtractedDocument(path="attachments/spec.docx", status="document"),
        )

        def broken(_spec):
            raise RuntimeError("drafts unreadable")

        monkeypatch.setattr(prompt, "rules_section", broken)

        with caplog.at_level("DEBUG", logger="docintel.prompt"):
            section = prompt.docintel_section(project, spec_dir)

        assert "ADR-0001" in section and "spec.docx` — document" in section
        assert "a prompt section failed" in caplog.text

    def test_without_a_task_only_the_project_is_read(self, project):
        adr(project, 1, "Accepted")

        section = prompt.docintel_section(project)

        assert section.startswith("## Architecture Decision Records (binding)")

"""Sequence diagrams of odd shapes, and the folders they are looked for in.

`test_docintel_code.py` checks a PlantUML and a Mermaid flow against a layered
project. This file covers the rest: a reverse arrow, a block without arrows, a
Mermaid fence that is another kind of chart, participants named by symbols, a
file too large or unreadable, more diagrams than the prompt keeps, an
attachment that points outside its task, and a project that cannot be read.
"""

from __future__ import annotations

import json
from pathlib import Path

from docintel import sequence
from docintel.sequence import (
    SymbolIndex,
    check_sequences,
    find_sequences,
    parse_plantuml,
    parse_sequence,
    verify,
)


def write(root: Path, relative: str, text: str) -> Path:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


CALL = "@startuml\nA -> B : Handle(cmd)\n@enduml\n"


class TestParsing:
    def test_a_reverse_arrow_is_a_call_from_its_right_side(self):
        diagram = parse_plantuml("@startuml\nB <- A : Handle(cmd)\n@enduml", "x.puml")

        assert [(c.source, c.target) for c in diagram.calls] == [("A", "B")]

    def test_a_block_without_arrows_is_skipped_for_the_next(self):
        text = "@startuml\ntitle Legend\n@enduml\n" + CALL

        assert len(parse_plantuml(text, "x.puml").calls) == 1

    def test_a_plantuml_fence_in_markdown_is_read(self):
        text = f"# Flow\n```plantuml\n{CALL}```\n"

        assert parse_sequence(text, "flow.md").format == "plantuml"

    def test_a_plantuml_fence_without_calls_gives_way_to_the_next(self):
        text = (
            f"```puml\n@startuml\nA --> B : ok\n@enduml\n```\n```plantuml\n{CALL}```\n"
        )

        assert len(parse_sequence(text, "flow.md").calls) == 1

    def test_a_mermaid_fence_of_another_chart_is_skipped(self):
        text = (
            "```mermaid\ngraph TD\n  A-->B\n```\n"
            "```mermaid\nsequenceDiagram\n  A->>B: Handle(cmd)\n```\n"
        )

        assert len(parse_sequence(text, "flows.md").calls) == 1

    def test_a_message_that_is_a_sentence_names_no_method(self):
        diagram = parse_plantuml("A -> B : returns the order", "x.puml")

        check = verify(diagram, SymbolIndex(Path("/nonexistent")), "repository")

        assert check.calls[0].status == "not-a-call"

    def test_participants_named_by_symbols_are_looked_up_by_alias(self, tmp_path):
        write(tmp_path, "b.py", "class B:\n    def handle(self): ...\n")
        diagram = parse_plantuml(
            '@startuml\nparticipant "?!" as B\nA -> B : handle()\n@enduml', "x.puml"
        )

        check = verify(diagram, SymbolIndex(tmp_path), "repository")

        assert check.calls[0].status == "verified"


class TestRepositoryDiagrams:
    def test_a_diagram_too_large_or_unreadable_is_skipped(self, tmp_path, monkeypatch):
        write(tmp_path, "docs/big.puml", CALL + "' " + "x" * 200 + "\n")
        locked = write(tmp_path, "docs/locked.puml", CALL)
        write(tmp_path, "docs/ok.puml", CALL)
        monkeypatch.setattr(sequence, "MAX_DIAGRAM_BYTES", 100)
        real = Path.read_bytes

        def read_bytes(self):
            if self == locked:
                raise PermissionError(self)
            return real(self)

        monkeypatch.setattr(Path, "read_bytes", read_bytes)

        assert [d.source for d in find_sequences(tmp_path)] == ["docs/ok.puml"]

    def test_the_count_stops_at_its_ceiling(self, tmp_path, monkeypatch):
        for name in ("a", "b", "c"):
            write(tmp_path, f"docs/{name}.puml", CALL)
        monkeypatch.setattr(sequence, "MAX_DIAGRAMS", 2)

        assert len(find_sequences(tmp_path)) == 2

    def test_a_project_that_cannot_be_read_says_so(self, tmp_path, monkeypatch):
        write(tmp_path, "docs/a.puml", CALL)

        def unreadable(self, _project):
            raise PermissionError("locked")

        monkeypatch.setattr(SymbolIndex, "__init__", unreadable)

        report = check_sequences(tmp_path)

        assert report.skipped == "unreadable" and report.checks == []


class TestAttachments:
    def test_an_attachment_outside_its_task_is_not_read(self, tmp_path):
        spec = tmp_path / "spec"
        outside = tmp_path / "outside.png"
        outside.write_bytes(b"\x89PNG\r\n\x1a\n")
        (spec / "docintel").mkdir(parents=True)
        (spec / "docintel" / "result.json").write_text(
            json.dumps(
                {
                    "documents": [
                        {
                            "path": "../outside.png",
                            "status": "text",
                            "threat": "safe",
                            "text": CALL,
                        }
                    ]
                }
            ),
            encoding="utf-8",
        )

        assert sequence.sequences_from_attachments(spec) == []


class TestReport:
    def test_the_report_reads_back_with_its_counts(self, tmp_path):
        write(tmp_path, "b.py", "class B:\n    def handle(self): ...\n")
        write(tmp_path, "docs/flow.puml", "@startuml\nA -> B : handle()\n@enduml\n")

        payload = check_sequences(tmp_path).to_dict()

        [check] = payload["checks"]
        assert (check["verified"], check["checkable"]) == (1, 1)
        assert check["calls"][0]["file"] == "b.py" and payload["skipped"] == ""

"""ERDs at their edges, and their comparison with the ORM.

`test_docintel_code.py` reads one ERD per format and compares it with an EF
Core model. This file covers what those leave out: ends drawn one-to-one or
many-to-many, boxes that name no table, arrows that join nothing, DBML notes,
ceilings on what is read, ERDs among the task's attachments, and every kind of
difference the section reports.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from docintel import erd
from docintel.erd import (
    Erd,
    ErdRelation,
    ErdTable,
    check_erd,
    compare,
    erd_from_diagram,
    erd_section,
    find_erds,
    parse_dbml,
)
from docintel.models import (
    DiagramEdge,
    DiagramModel,
    DiagramNode,
    DocintelResult,
    ExtractedDocument,
)
from docintel.orm import read_orm

from tests.test_docintel_code import DBML, DRAWIO_ERD, EF_CONTEXT, EF_ENTITIES


def write(root: Path, relative: str, text: str) -> Path:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


@pytest.fixture
def efcore(tmp_path: Path) -> Path:
    root = tmp_path / "ef"
    write(root, "src/Acme.Domain/Entities.cs", EF_ENTITIES)
    write(root, "src/Acme.Infrastructure/AppDbContext.cs", EF_CONTEXT)
    return root


def drawn(*tables: str, relations: tuple[ErdRelation, ...] = ()) -> Erd:
    return Erd(
        source="docs/model.dbml",
        format="dbml",
        tables=[ErdTable(t) for t in tables],
        relations=list(relations),
    )


class TestTheDiagram:
    def test_ends_drawn_alike_are_one_to_one_or_many_to_many(self):
        model = DiagramModel(
            format="drawio",
            nodes=[
                DiagramNode("a", "Accounts"),
                DiagramNode("p", "Profiles"),
                DiagramNode("t", "Tags"),
                DiagramNode("n", "123"),
            ],
            edges=[
                DiagramEdge("a", "p", source_end="one", target_end="one"),
                DiagramEdge("p", "t", source_end="many", target_end="many"),
                DiagramEdge("a", "n", source_end="one", target_end="many"),
                DiagramEdge("a", "a", source_end="one", target_end="many"),
            ],
        )

        found = erd_from_diagram(model, "docs/data.drawio")

        assert [t.name for t in found.tables] == ["Accounts", "Profiles", "Tags"]
        assert [(r.kind, r.a, r.b) for r in found.relations] == [
            ("1:1", "Accounts", "Profiles"),
            ("N:N", "Profiles", "Tags"),
        ]

    def test_boxes_that_name_no_table_make_no_erd(self):
        model = DiagramModel(
            format="drawio",
            nodes=[DiagramNode("a", "42"), DiagramNode("b", "")],
            edges=[DiagramEdge("a", "b", source_end="one", target_end="many")],
        )

        assert erd_from_diagram(model, "docs/data.drawio") is None

    def test_a_dbml_note_or_index_block_is_no_column(self):
        found = parse_dbml(
            'Table orders {\n  id int\n  Note "kept for audit"\n  indexes (id)\n}\n',
            "model.dbml",
        )

        assert found.tables[0].columns == ["id"]


class TestReading:
    def test_erds_too_big_or_unreadable_are_left_and_the_count_stops(
        self, tmp_path, monkeypatch
    ):
        write(tmp_path, "docs/a.dbml", DBML)
        write(tmp_path, "docs/b.dbml", DBML)
        write(tmp_path, "docs/big.dbml", DBML + " " * 512)
        locked = write(tmp_path, "docs/c.dbml", DBML)
        monkeypatch.setattr(erd, "MAX_DIAGRAM_BYTES", len(DBML) + 64)
        real = Path.read_bytes

        def read_bytes(self):
            if self == locked:
                raise PermissionError(self)
            return real(self)

        monkeypatch.setattr(Path, "read_bytes", read_bytes)

        assert sorted(e.source for e in find_erds(tmp_path)) == [
            "docs/a.dbml",
            "docs/b.dbml",
        ]
        monkeypatch.setattr(erd, "MAX_ERDS", 1)
        assert len(find_erds(tmp_path)) == 1

    def test_attached_erds_drawn_or_read_from_an_image(self, tmp_path):
        spec = tmp_path / "spec"
        target = spec / "docintel" / "result.json"
        target.parent.mkdir(parents=True)
        diagram = DiagramModel(
            format="drawio",
            nodes=[DiagramNode("c", "Customers"), DiagramNode("o", "Orders")],
            edges=[DiagramEdge("c", "o", source_end="one", target_end="many")],
        )
        docs = [
            ExtractedDocument(
                path="attachments/data.drawio", status="ok", diagram=diagram
            ),
            ExtractedDocument(
                path="attachments/board.png",
                status="text",
                engine="tesseract",
                text=DBML,
            ),
        ]
        target.write_text(
            json.dumps(DocintelResult(documents=docs).to_dict()), encoding="utf-8"
        )

        found = erd.erds_from_attachments(spec)

        assert [(e.source, e.format) for e in found] == [
            ("attachments/data.drawio", "drawio"),
            ("attachments/board.png", "dbml (tesseract)"),
        ]

    def test_a_repository_that_cannot_be_read_says_so(self, efcore, monkeypatch):
        write(efcore, "docs/model.dbml", DBML)

        def unreadable(_root):
            raise PermissionError("locked")

        monkeypatch.setattr(erd, "read_orm", unreadable)

        assert check_erd(efcore).skipped == "unreadable"


class TestTheComparison:
    def test_an_erd_that_names_no_entity_is_not_judged(self, efcore):
        check, findings = compare(drawn("Planets", "Moons"), read_orm(efcore), "x")

        assert (check.status, findings) == ("no-match", [])

    def test_one_drawn_entity_reports_no_undrawn_ones(self, efcore):
        check, findings = compare(drawn("customers"), read_orm(efcore), "x")

        assert check.matched == {"customers": "Customer"} and findings == []

    def test_a_relation_drawn_without_its_mapping_and_one_mapped_not_drawn(
        self, efcore
    ):
        erd_model = drawn(
            "customers",
            "orders",
            "order_lines",
            relations=(
                ErdRelation("customers", "order_lines", "1:N", "markers"),
                ErdRelation("customers", "orders", "1:N", "markers"),
                ErdRelation("customers", "payments", "1:N", "markers"),
            ),
        )

        _check, findings = compare(erd_model, read_orm(efcore), "repository")

        kinds = {(f.kind, f.subject, f.drawn, f.code) for f in findings}
        assert (
            "missing-relation",
            "customers — order_lines",
            "customers 1:N order_lines",
            "",
        ) in kinds
        assert any(
            f.kind == "undrawn-relation" and f.code == "Order 1:N OrderLine"
            for f in findings
        )

    def test_the_section_says_each_difference_and_what_it_cannot_judge(self, efcore):
        write(
            efcore,
            "docs/model.dbml",
            "Table customers { id int }\nTable orders { id int }\n"
            "Table order_lines { id int }\n"
            "Ref: customers.id < order_lines.id\n"
            "Ref: customers.id < orders.id\n",
        )
        write(efcore, "docs/data.drawio", DRAWIO_ERD)

        section = erd_section(efcore)

        assert (
            "- customers — order_lines — drawn, no mapping relates them: "
            "`customers 1:N order_lines`"
        ) in section
        assert "- Order — OrderLine — mapped, not drawn: `Order 1:N OrderLine`" in (
            section
        )
        assert "Not judged (the diagram does not say): " in section

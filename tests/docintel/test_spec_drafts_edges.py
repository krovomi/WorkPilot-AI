"""Requirements proposed from an attachment, at the edges of reading and deciding.

`test_docintel_specs.py` proposes requirements and criteria from a
specification and follows a decision into `spec.md`. This file covers the
rest: sentences too long, repeated or past the ceiling, scenarios that end
another way, a record edited by hand, a drafts file that cannot be written or
removed, a spec whose section already exists or has no requirements heading,
and the pieces around a decision that may fail without failing it.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from docintel import spec_drafts
from docintel.spec_drafts import (
    DraftSet,
    SourceText,
    decide,
    drafts_path,
    load_drafts,
    propose_criteria,
    propose_requirements,
    refresh,
)
from docintel.tables import RuleTable


@pytest.fixture
def spec_dir(tmp_path: Path) -> Path:
    spec = tmp_path / ".workpilot" / "specs" / "001-orders"
    spec.mkdir(parents=True)
    return spec


def sources(text: str, name: str = "attachments/cdc.md", **extra) -> list[SourceText]:
    return [SourceText(source=name, text=text, **extra)]


class TestRequirements:
    def test_a_long_sentence_is_cut_at_a_word(self):
        sentence = "The system must keep " + "every order " * 60 + "forever."

        [draft] = propose_requirements(sentence + "\n\n", "cdc.md")

        assert len(draft.text) <= spec_drafts.MAX_CHARS + 1
        assert draft.text.endswith("…")
        assert draft.text[:-1].split()[-1] in ("every", "order")

    def test_a_sentence_said_twice_is_proposed_once(self):
        text = "The app must log in.\n\nThe app must log in.\n"

        assert len(propose_requirements(text, "cdc.md")) == 1

    def test_the_proposals_stop_at_their_ceiling(self, monkeypatch):
        monkeypatch.setattr(spec_drafts, "MAX_REQUIREMENTS", 2)
        text = "\n\n".join(f"The app must handle case number {n}." for n in range(5))

        assert len(propose_requirements(text, "cdc.md")) == 2


class TestCriteria:
    def test_scenarios_ended_by_prose_or_a_new_scenario(self):
        text = (
            "Scenario: paid\n"
            "Given a paid order\nWhen it ships\nThen the customer is told\n"
            "Some prose that ends the scenario.\n"
            "Scenario: draft\n"
            "Given a draft order\nWhen it is saved\n"
            "Scenario: again\n"
            "Given a paid order\nWhen it ships\nThen the customer is told\n"
        )

        criteria = propose_criteria(text, "cdc.md")

        assert [c.text for c in criteria] == [
            "Given a paid order When it ships Then the customer is told"
        ]

    def test_bullets_stop_at_the_next_heading_and_short_ones_are_none(self):
        text = (
            "Acceptance criteria\n"
            "- Totals match the ledger to the cent\n"
            "- Too short\n"
            "Each of them is checked by QA.\n"
            "- Refunds reach the card within a week\n"
            "Delivery\n"
            "- Parcels leave within two working days\n"
        )

        assert [c.text for c in propose_criteria(text, "cdc.md")] == [
            "Totals match the ledger to the cent",
            "Refunds reach the card within a week",
        ]

    def test_the_criteria_stop_at_their_ceiling(self, monkeypatch):
        monkeypatch.setattr(spec_drafts, "MAX_CRITERIA", 1)
        text = "Acceptance criteria\n- First criterion that counts\n- Second criterion too\n"

        assert len(propose_criteria(text, "cdc.md")) == 1


class TestTheRecord:
    def test_a_record_edited_by_hand_keeps_what_it_can(self, spec_dir):
        drafts_path(spec_dir).parent.mkdir(parents=True)
        drafts_path(spec_dir).write_text(
            json.dumps(
                {
                    "requirements": [
                        {
                            "key": "req-1",
                            "id": "FR-001",
                            "kind": "FR",
                            "text": "Keep",
                            "source": "a",
                        },
                        {"key": "req-2", "text": "No kind or id"},
                        {
                            "key": "req-3",
                            "id": "",
                            "kind": "XR",
                            "text": "Odd",
                            "source": "a",
                        },
                    ],
                    "criteria": [
                        {"key": "ac-1"},
                        {"key": "ac-2", "text": "Ok", "source": "a"},
                    ],
                    "tables": [
                        "not a table",
                        {
                            "key": "t",
                            "table": {"headers": ["a"]},
                            "tests": [{"code": "x"}],
                        },
                    ],
                }
            ),
            encoding="utf-8",
        )

        drafts = load_drafts(spec_dir)

        assert [r.key for r in drafts.requirements] == ["req-1"]
        assert [c.key for c in drafts.criteria] == ["ac-2"]
        assert len(drafts.tables) == 1 and drafts.tables[0].tests == []

    def test_an_accepted_id_of_another_shape_takes_no_number(self, spec_dir):
        drafts_path(spec_dir).parent.mkdir(parents=True)
        record = DraftSet.from_dict(
            {
                "requirements": [
                    {
                        "key": "req-1",
                        "id": "FR",
                        "kind": "FR",
                        "text": "Old",
                        "source": "a",
                        "status": "accepted",
                    },
                    {
                        "key": "req-2",
                        "id": "",
                        "kind": "FR",
                        "text": "New one",
                        "source": "a",
                    },
                ]
            }
        )
        spec_drafts.save_drafts(spec_dir, record)

        decision = decide(spec_dir, accept_requirements={"req-2": ""})

        assert decision.requirements[0]["id"] == "FR-001"

    def test_a_drafts_file_behind_a_link_is_not_written(self, spec_dir, tmp_path):
        elsewhere = tmp_path / "elsewhere.json"
        elsewhere.write_text("{}", encoding="utf-8")
        drafts_path(spec_dir).parent.mkdir(parents=True)
        try:
            drafts_path(spec_dir).symlink_to(elsewhere)
        except OSError:  # Windows without the right to make one
            pytest.skip("symbolic links are not available here")

        spec_drafts.save_drafts(spec_dir, DraftSet(sources=["x"]))

        assert elsewhere.read_text(encoding="utf-8") == "{}"

    def test_a_drafts_file_that_cannot_be_written_is_left(self, spec_dir, monkeypatch):
        def refuse(self, *_args, **_kwargs):
            raise PermissionError(self)

        monkeypatch.setattr(Path, "write_text", refuse)

        spec_drafts.save_drafts(spec_dir, DraftSet(sources=["x"]))

        assert not drafts_path(spec_dir).exists()

    def test_nothing_left_to_propose_removes_the_old_file(self, spec_dir, monkeypatch):
        refresh(spec_dir, sources("The app must log in."), None)
        assert drafts_path(spec_dir).is_file()
        (spec_dir / "docintel" / "drafts.json").write_text("{}", encoding="utf-8")

        assert refresh(spec_dir, sources("Nothing to see."), None) is None
        assert not drafts_path(spec_dir).exists()

    def test_an_old_file_that_cannot_be_removed_stays(self, spec_dir, monkeypatch):
        drafts_path(spec_dir).parent.mkdir(parents=True)
        drafts_path(spec_dir).write_text("{}", encoding="utf-8")

        def refuse(self, *_args, **_kwargs):
            raise PermissionError(self)

        monkeypatch.setattr(Path, "unlink", refuse)

        assert refresh(spec_dir, sources("Nothing to see."), None) is None
        assert drafts_path(spec_dir).is_file()

    def test_a_task_description_that_is_no_json_takes_no_id(self, spec_dir):
        (spec_dir / "requirements.json").write_text("{ not json", encoding="utf-8")

        drafts = refresh(spec_dir, sources("The app must log in."), None)

        assert drafts.requirements[0].id == "FR-001"


class TestRefresh:
    def test_tables_ask_for_the_project_languages_once(self, spec_dir, monkeypatch):
        table = RuleTable(headers=["a", "b"], rows=[["1", "2"], ["3", "4"]])
        calls = []

        def languages(project_dir):
            calls.append(project_dir)
            return ["python"]

        monkeypatch.setattr(spec_drafts, "project_languages", languages)

        drafts = refresh(
            spec_dir,
            sources("No requirement.", tables=[table, table]),
            spec_dir,
        )

        assert calls == [spec_dir] and len(drafts.tables) == 1

    def test_the_same_sentence_in_two_attachments_is_one_proposal(self, spec_dir):
        both = sources("The app must log in.") + sources(
            "The app must log in.", name="attachments/other.md"
        )

        drafts = refresh(spec_dir, both, None)

        assert len(drafts.requirements) == 1


SPEC = "# Orders\n\n## Requirements\n\n- FR-001 existing\n"


class TestDeciding:
    def proposals(self, spec_dir: Path, text: str) -> DraftSet:
        return refresh(spec_dir, sources(text), None)

    def test_no_drafts_no_decision(self, spec_dir):
        assert decide(spec_dir, accept_requirements={"x": "y"}).requirements == []

    def test_a_second_decision_adds_to_the_existing_section(self, spec_dir):
        (spec_dir / "spec.md").write_text(SPEC + "\n## QA\n\nok\n", encoding="utf-8")
        drafts = self.proposals(
            spec_dir, "The app must log in.\n\nThe app must log out."
        )
        first, second = drafts.requirements

        decide(spec_dir, accept_requirements={first.key: ""})
        decide(spec_dir, accept_requirements={second.key: ""})

        spec = (spec_dir / "spec.md").read_text(encoding="utf-8")
        assert spec.count("## Requirements from attachments") == 1
        assert spec.index("FR-003") < spec.index("## QA")

    def test_a_spec_without_a_requirements_heading_gets_the_section_last(
        self, spec_dir
    ):
        (spec_dir / "spec.md").write_text("# Orders\n\nIntro.\n", encoding="utf-8")
        drafts = self.proposals(spec_dir, "The app must log in.")

        decide(spec_dir, accept_requirements={drafts.requirements[0].key: ""})

        spec = (spec_dir / "spec.md").read_text(encoding="utf-8")
        assert spec.rstrip().endswith("_(from `cdc.md`)_")

    def test_criteria_rejected_or_already_decided(self, spec_dir):
        text = (
            "Acceptance criteria\n- Totals match the ledger to the cent\n"
            "- Refunds reach the card within a week\n"
        )
        drafts = self.proposals(spec_dir, text)
        keep, drop = drafts.criteria

        decide(spec_dir, accept_criteria={keep.key: ""}, reject_criteria=[drop.key])
        again = decide(spec_dir, accept_criteria={keep.key: "", drop.key: ""})

        assert [c.status for c in load_drafts(spec_dir).criteria] == [
            "accepted",
            "rejected",
        ]
        assert again.criteria == []

    def test_a_spec_that_cannot_be_written_goes_to_the_description(
        self, spec_dir, monkeypatch
    ):
        (spec_dir / "spec.md").write_text(SPEC, encoding="utf-8")
        drafts = self.proposals(spec_dir, "The app must log in.")
        real = Path.write_text

        def write_text(self, *args, **kwargs):
            if self.name == "spec.md":
                raise PermissionError(self)
            return real(self, *args, **kwargs)

        monkeypatch.setattr(Path, "write_text", write_text)

        decision = decide(
            spec_dir, accept_requirements={drafts.requirements[0].key: ""}
        )

        assert not decision.spec_updated
        assert "**FR-002**" in decision.description_section

    def test_a_traceability_refresh_that_fails_leaves_the_decision(
        self, spec_dir, monkeypatch
    ):
        import foundation.traceability as traceability

        (spec_dir / "spec.md").write_text(SPEC, encoding="utf-8")
        (spec_dir / "traceability.json").write_text("{}", encoding="utf-8")
        drafts = self.proposals(spec_dir, "The app must log in.")

        def broken(_spec_dir):
            raise ValueError("unreadable")

        monkeypatch.setattr(traceability, "write_record", broken)

        decision = decide(
            spec_dir, accept_requirements={drafts.requirements[0].key: ""}
        )

        assert decision.spec_updated and decision.traceability == ""

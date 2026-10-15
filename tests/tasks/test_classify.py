"""The kind of a card, decided without a model (kanban-task-types.md, lot 0)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from tasks import TaskKind, classify, classify_spec, read_task_metadata, record_kind


@pytest.mark.parametrize(
    ("title", "kind"),
    [
        ("Corriger le crash au démarrage", TaskKind.BUG_FIX),
        ("Fix NullReferenceException in OrderService", TaskKind.BUG_FIX),
        ("L'export PDF ne fonctionne plus", TaskKind.BUG_FIX),
        ("Régression sur la page de login", TaskKind.BUG_FIX),
        ("Comprendre pourquoi le build est flaky", TaskKind.INVESTIGATION),
        ("Investigate intermittent timeouts", TaskKind.INVESTIGATION),
        ("Relancer le job de nuit", TaskKind.RUN),
        ("Rotate the API key for the staging environment", TaskKind.RUN),
        ("Purger le cache Redis", TaskKind.RUN),
        ("Refactor the payment module", TaskKind.REFACTORING),
        ("Réduire la dette technique du module facturation", TaskKind.REFACTORING),
        ("Ajouter des tests unitaires sur le calcul de TVA", TaskKind.TEST),
        ("Write unit tests for the parser", TaskKind.TEST),
        ("Documenter l'API de facturation", TaskKind.DOCS),
        ("Update the README", TaskKind.DOCS),
        ("POC : évaluer gRPC pour le service de notification", TaskKind.SPIKE),
        ("Spike: compare Kafka and SQS", TaskKind.SPIKE),
        ("Ajouter l'export PDF des factures", TaskKind.FEATURE),
        ("Add dark mode", TaskKind.FEATURE),
    ],
)
def test_the_words_of_the_title_decide(title, kind):
    verdict = classify(title)
    assert verdict.kind is kind, verdict


def test_accents_and_case_do_not_matter():
    assert classify("RÉGRESSION : l'écran plante").kind is TaskKind.BUG_FIX


def test_nothing_said_is_a_feature_with_low_confidence():
    verdict = classify("Ajouter l'export PDF des factures")
    assert verdict.kind is TaskKind.FEATURE
    assert verdict.source == "default"
    assert verdict.ambiguous


def test_keywords_alone_are_confident_enough_not_to_ask():
    verdict = classify("Fix the crash on startup")
    assert verdict.source == "keywords"
    assert not verdict.ambiguous


def test_two_families_of_words_make_it_a_proposal():
    verdict = classify("Comprendre pourquoi le fix de hier a cassé le build")
    assert verdict.kind is TaskKind.INVESTIGATION
    assert verdict.ambiguous
    assert "also bug_fix" in verdict.reasons[0]


class TestTheCategoryWins:
    def test_a_category_beats_the_words(self):
        verdict = classify("Fix the layout", metadata={"category": "documentation"})
        assert verdict.kind is TaskKind.DOCS
        assert verdict.source == "category"
        assert not verdict.ambiguous

    def test_feature_category_is_a_confident_feature(self):
        verdict = classify("Corriger le wording", metadata={"category": "feature"})
        # The words say bug; the user said feature, confidently.
        assert verdict.kind is TaskKind.FEATURE
        assert verdict.source == "category"

    @pytest.mark.parametrize("category", ["security", "performance", "ui_ux"])
    def test_lens_like_categories_stay_a_feature_build(self, category):
        verdict = classify("Harden the login", metadata={"category": category})
        assert verdict.kind is TaskKind.FEATURE


class TestImportedItems:
    def test_a_jira_bug_is_a_bug(self):
        verdict = classify("PROJ-12", metadata={"jiraType": "Bug"})
        assert verdict.kind is TaskKind.BUG_FIX
        assert verdict.source == "import"

    def test_an_azure_task_is_a_feature(self):
        verdict = classify("12345", metadata={"azureDevOpsType": "User Story"})
        assert verdict.kind is TaskKind.FEATURE

    def test_a_recognised_label_counts(self):
        verdict = classify(
            "Timeouts", metadata={"labels": ["needs-triage", "incident"]}
        )
        assert verdict.kind is TaskKind.HOTFIX


class TestHotfix:
    def test_an_urgent_bug_is_a_hotfix(self):
        verdict = classify("Fix the checkout crash", metadata={"priority": "urgent"})
        assert verdict.kind is TaskKind.HOTFIX
        assert any("urgent" in r for r in verdict.reasons)

    def test_production_words_make_a_bug_a_hotfix(self):
        assert classify("Crash en prod sur le paiement").kind is TaskKind.HOTFIX

    def test_urgency_alone_is_not_a_hotfix(self):
        # Urgent feature: still a feature. Hotfix is a bug with urgency.
        verdict = classify("Add the export, urgent", metadata={"priority": "urgent"})
        assert verdict.kind is TaskKind.FEATURE


class TestTheUsersChoice:
    def test_a_kind_chosen_in_the_ui_is_never_overwritten(self):
        verdict = classify(
            "Fix the crash", metadata={"kind": "investigation", "kindSource": "user"}
        )
        assert verdict.kind is TaskKind.INVESTIGATION
        assert verdict.source == "user"
        assert verdict.confidence == 1.0

    def test_an_unknown_user_kind_falls_through(self):
        verdict = classify(
            "Fix the crash", metadata={"kind": "banana", "kindSource": "user"}
        )
        assert verdict.kind is TaskKind.BUG_FIX


class TestMetadataFile:
    def test_the_kind_is_recorded_beside_the_rest(self, tmp_path: Path):
        (tmp_path / "task_metadata.json").write_text(
            json.dumps(
                {"sourceType": "manual", "category": "bug_fix", "priority": "high"}
            ),
            encoding="utf-8",
        )
        verdict = classify_spec(tmp_path, "Crash au démarrage")
        assert verdict.kind is TaskKind.BUG_FIX
        written = read_task_metadata(tmp_path)
        assert written["kind"] == "bug_fix"
        assert written["kindSource"] == "category"
        assert written["kindConfidence"] == 0.9
        assert written["sourceType"] == "manual" and written["priority"] == "high"

    def test_without_a_file_one_is_created(self, tmp_path: Path):
        classify_spec(tmp_path, "Relancer le job")
        assert read_task_metadata(tmp_path)["kind"] == "run"

    def test_the_users_kind_survives_a_new_classification(self, tmp_path: Path):
        (tmp_path / "task_metadata.json").write_text(
            json.dumps({"kind": "spike", "kindSource": "user", "kindConfidence": 1}),
            encoding="utf-8",
        )
        record_kind(tmp_path, classify("Fix the crash"))
        assert read_task_metadata(tmp_path)["kind"] == "spike"

    def test_an_unreadable_file_is_empty_not_an_error(self, tmp_path: Path):
        (tmp_path / "task_metadata.json").write_text("{not json", encoding="utf-8")
        assert read_task_metadata(tmp_path) == {}

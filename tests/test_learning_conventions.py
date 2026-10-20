"""Conventions learned from builds, and the gate that stops them being noise.

`core/learning_loop.py` could discover these and never ran. Its promotion rule
was the reason not to revive it as-is: it proposed a convention once its own
`confidence_score` passed 0.7, having been triggered by a `success` flag the
caller asserted. The tests that matter here are the ones proving the ported
version cannot do that.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from learning_loop.conventions import (  # noqa: E402
    apply_convention,
    candidates_from_files,
    conventions_dir,
    load_ledger,
    promote,
    record_observation,
    run_convention_pass,
)
from learning_loop.skill_proposer import (  # noqa: E402
    MIN_OCCURRENCES,
    MIN_VERIFIED_OUTCOMES,
    ExternalSignal,
)

GREEN = [ExternalSignal.TESTS_PASSED]


# ── discovery ────────────────────────────────────────────────────────────


class TestNamingDiscovery:
    def test_a_consistent_snake_case_extension_is_found(self):
        found = candidates_from_files(
            ["a/user_service.py", "a/order_repo.py", "a/mail_sender.py"]
        )
        assert any(c.convention_id == "naming:.py:snake_case" for c in found)

    def test_a_single_word_name_is_not_evidence(self):
        """`utils` is snake_case, camelCase and kebab-case at once.

        The original classifier tested snake_case first and so counted every
        one-word module as evidence for it.
        """
        found = candidates_from_files(["a/utils.py", "a/models.py", "a/views.py"])
        assert [c for c in found if c.kind == "naming"] == []

    def test_extensions_are_judged_separately(self):
        """PascalCase .tsx beside snake_case .py is consistent, not a conflict."""
        found = candidates_from_files(
            [
                "a/user_service.py",
                "a/order_repo.py",
                "a/mail_sender.py",
                "b/UserCard.tsx",
                "b/OrderList.tsx",
                "b/MailBanner.tsx",
            ]
        )
        ids = {c.convention_id for c in found}
        assert "naming:.py:snake_case" in ids
        assert "naming:.tsx:PascalCase" in ids

    def test_a_split_vote_is_not_a_convention(self):
        found = candidates_from_files(
            [
                "a/user_service.py",
                "a/order_repo.py",
                "a/mail_sender.py",
                "a/UserCard.py",
                "a/OrderList.py",
                "a/MailBanner.py",
            ]
        )
        assert [c for c in found if c.kind == "naming"] == []

    def test_tool_dictated_names_are_ignored(self):
        found = candidates_from_files(
            ["a/__init__.py", "b/__init__.py", "c/__init__.py"]
        )
        assert [c for c in found if c.kind == "naming"] == []

    def test_too_few_files_say_nothing(self):
        found = candidates_from_files(["a/user_service.py", "a/order_repo.py"])
        assert [c for c in found if c.kind == "naming"] == []


class TestStructureDiscovery:
    def test_a_single_extension_directory_is_found(self):
        found = candidates_from_files(
            ["hooks/use_a.ts", "hooks/use_b.ts", "hooks/use_c.ts"]
        )
        assert any(c.convention_id == "structure:hooks:.ts" for c in found)

    def test_a_mixed_directory_is_not(self):
        found = candidates_from_files(
            ["hooks/use_a.ts", "hooks/use_b.ts", "hooks/style_c.css"]
        )
        assert [c for c in found if c.kind == "structure"] == []


class TestPurity:
    def test_discovery_touches_no_disk_and_no_model(self):
        """This half of the loop is free, which is why it always runs."""
        assert candidates_from_files([]) == []
        assert candidates_from_files(["/nonexistent/a_b.py"] * 3)


# ── the promotion gate ───────────────────────────────────────────────────


FILES = ["a/user_service.py", "a/order_repo.py", "a/mail_sender.py"]


def _observe(project: Path, build: str, signals):
    record_observation(project, candidates_from_files(FILES), signals, build)


class TestPromotionNeedsExternalEvidence:
    def test_frequency_alone_never_promotes(self, tmp_path: Path):
        """The failure mode of the version that was never wired.

        Ten builds that nothing verified are ten unverified builds.
        """
        for i in range(MIN_OCCURRENCES + 7):
            _observe(tmp_path, f"build-{i}", [])
        assert promote(tmp_path) == []

    def test_corroboration_alone_never_promotes(self, tmp_path: Path):
        for i in range(MIN_VERIFIED_OUTCOMES):
            _observe(tmp_path, f"build-{i}", GREEN)
        assert MIN_VERIFIED_OUTCOMES < MIN_OCCURRENCES
        assert promote(tmp_path) == []

    def test_both_together_promote(self, tmp_path: Path):
        for i in range(MIN_OCCURRENCES):
            _observe(tmp_path, f"build-{i}", GREEN)
        written = promote(tmp_path)
        assert written
        assert written[0].read_text(encoding="utf-8").count("snake_case")

    def test_one_build_cannot_corroborate_itself(self, tmp_path: Path):
        """Re-running observe on the same build must not accumulate."""
        for _ in range(MIN_OCCURRENCES + 5):
            _observe(tmp_path, "build-same", GREEN)
        entry = load_ledger(tmp_path)["naming:.py:snake_case"]
        assert entry["occurrences"] == 1
        assert promote(tmp_path) == []

    def test_a_proposal_is_written_once(self, tmp_path: Path):
        for i in range(MIN_OCCURRENCES):
            _observe(tmp_path, f"build-{i}", GREEN)
        assert promote(tmp_path)
        assert promote(tmp_path) == []


# ── adoption is a person's decision ──────────────────────────────────────


class TestAdoption:
    def _promoted(self, tmp_path: Path) -> Path:
        for i in range(MIN_OCCURRENCES):
            _observe(tmp_path, f"build-{i}", GREEN)
        return promote(tmp_path)[0]

    def test_promotion_writes_no_convention_file(self, tmp_path: Path):
        """The old version applied its own proposals as a side effect."""
        self._promoted(tmp_path)
        assert not (tmp_path / ".workpilot" / "conventions.md").exists()

    def test_applying_writes_the_statement(self, tmp_path: Path):
        self._promoted(tmp_path)
        assert apply_convention(tmp_path, "naming:.py:snake_case")
        body = (tmp_path / ".workpilot" / "conventions.md").read_text(encoding="utf-8")
        assert "snake_case" in body

    def test_applying_clears_the_proposal(self, tmp_path: Path):
        path = self._promoted(tmp_path)
        apply_convention(tmp_path, "naming:.py:snake_case")
        assert not path.exists()

    def test_applying_twice_does_not_duplicate(self, tmp_path: Path):
        self._promoted(tmp_path)
        apply_convention(tmp_path, "naming:.py:snake_case")
        apply_convention(tmp_path, "naming:.py:snake_case")
        body = (tmp_path / ".workpilot" / "conventions.md").read_text(encoding="utf-8")
        assert body.count("`.py` files are named in snake_case.") == 1

    def test_applying_preserves_existing_content(self, tmp_path: Path):
        target = tmp_path / ".workpilot" / "conventions.md"
        target.parent.mkdir(parents=True)
        target.write_text("# Conventions\n\nEcrit a la main.\n", encoding="utf-8")
        self._promoted(tmp_path)
        apply_convention(tmp_path, "naming:.py:snake_case")
        assert "Ecrit a la main." in target.read_text(encoding="utf-8")

    def test_an_unknown_convention_is_refused(self, tmp_path: Path):
        assert apply_convention(tmp_path, "naming:.py:nope") is False


# ── the phase entry point ────────────────────────────────────────────────


class TestPhaseEntryPoint:
    def test_it_records_and_promotes(self, tmp_path: Path):
        for i in range(MIN_OCCURRENCES - 1):
            run_convention_pass(tmp_path, FILES, GREEN, f"build-{i}")
        recorded, proposals = run_convention_pass(
            tmp_path, FILES, GREEN, f"build-{MIN_OCCURRENCES}"
        )
        assert recorded
        assert proposals

    def test_no_files_is_not_an_error(self, tmp_path: Path):
        assert run_convention_pass(tmp_path, [], GREEN, "b") == (0, [])

    def test_a_broken_ledger_does_not_raise(self, tmp_path: Path):
        conventions_dir(tmp_path).mkdir(parents=True)
        (conventions_dir(tmp_path) / "ledger.json").write_text(
            "{ broken", encoding="utf-8"
        )
        recorded, proposals = run_convention_pass(tmp_path, FILES, GREEN, "b")
        assert recorded  # unreadable ledger is treated as empty, not fatal

    @pytest.mark.parametrize("signals", [[], GREEN])
    def test_it_never_raises(self, tmp_path: Path, signals):
        assert run_convention_pass(tmp_path, FILES, signals, "b") is not None

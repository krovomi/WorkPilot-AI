"""The refactoring agent on a real file: the smells it names and the ones it
has no automatic refactoring for."""

from __future__ import annotations

from pathlib import Path

from agents.refactorer import RefactoringAgent
from agents.refactorer_smells import SmellType

SOURCE = '''"""Pricing."""

from decimal import Decimal
from json import dumps


def grade(score: int) -> str:
    """The letter for a score."""
    if score > 90:
        return "A"
    if score > 80:
        return "B"
    if score > 70:
        return "C"
    if score > 60:
        return "D"
    return "F"







def price() -> Decimal:
    """A price."""
    return Decimal(1)
'''


def _write(tmp_path: Path) -> Path:
    path = tmp_path / "pricing.py"
    path.write_text(SOURCE, encoding="utf-8")
    return path


def test_the_smells_of_a_file_on_disk_are_found(tmp_path: Path) -> None:
    smells = RefactoringAgent().detect_smells(str(_write(tmp_path)))

    kinds = {s.smell_type for s in smells}
    assert SmellType.TOO_MANY_RETURNS in kinds
    assert [
        s.symbol_name for s in smells if s.smell_type == SmellType.UNUSED_IMPORT
    ] == ["dumps"]
    # Seven blank lines in a row are no duplicated block.
    assert SmellType.DUPLICATE_CODE not in kinds


def test_a_smell_without_an_automatic_refactoring_gets_no_proposal(
    tmp_path: Path,
) -> None:
    agent = RefactoringAgent()

    proposals = agent.propose_refactoring(file_path=str(_write(tmp_path)))

    assert proposals
    assert all("grade" not in p.description for p in proposals)
    assert agent.propose_refactoring() == []


def test_an_executed_proposal_is_kept_in_the_results(tmp_path: Path) -> None:
    agent = RefactoringAgent()
    [proposal, *_] = agent.propose_refactoring(file_path=str(_write(tmp_path)))

    result = agent.execute_refactoring(proposal)

    assert result.success
    assert agent.get_results() == [result]

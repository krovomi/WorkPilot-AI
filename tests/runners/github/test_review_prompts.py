"""The prompts and vocabularies the GitHub review and triage agents work with.

`PromptManager` (runners/github/services/prompt_manager.py) hands each review
pass its instructions and reads the reviewer, follow-up and triage prompts
from `prompts/github/`, with a built-in fallback when a file is missing.
`map_category` (category_utils.py) turns the category a model invents into
one the app has a badge for. The services package loads its classes on first
use, so importing it stays cheap and free of the orchestrator's import cycle.
"""

from __future__ import annotations

import importlib

import pytest
from runners.github.models import ReviewCategory, ReviewPass
from runners.github.services.category_utils import map_category
from runners.github.services.prompt_manager import PromptManager


def test_every_review_pass_has_its_own_instructions():
    manager = PromptManager()
    prompts = {p: manager.get_review_pass_prompt(p) for p in ReviewPass}
    assert all(prompts.values())
    assert len(set(prompts.values())) == len(ReviewPass)
    assert "PRELIMINARY VERIFICATION" in prompts[ReviewPass.QUICK_SCAN]
    assert "```json" in prompts[ReviewPass.AI_COMMENT_TRIAGE]


def test_the_shipped_prompt_files_are_used():
    manager = PromptManager()
    shipped = manager.prompts_dir
    assert shipped.name == "github" and (shipped / "pr_reviewer.md").is_file()
    assert manager.get_pr_review_prompt() == (shipped / "pr_reviewer.md").read_text(
        encoding="utf-8"
    )
    assert manager.get_followup_review_prompt() == (
        shipped / "pr_followup.md"
    ).read_text(encoding="utf-8")
    assert manager.get_triage_prompt() == (shipped / "issue_triager.md").read_text(
        encoding="utf-8"
    )


def test_a_custom_prompt_folder_overrides_and_falls_back(tmp_path):
    (tmp_path / "issue_triager.md").write_text("Triage like a pirate", encoding="utf-8")
    manager = PromptManager(prompts_dir=tmp_path)
    assert manager.get_triage_prompt() == "Triage like a pirate"
    assert manager.get_pr_review_prompt().startswith("# PR Review Agent")
    assert manager.get_followup_review_prompt().startswith(
        "# PR Follow-up Review Agent"
    )
    empty = PromptManager(prompts_dir=tmp_path / "none")
    assert empty.get_triage_prompt().startswith("# Issue Triage Agent")


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("security", ReviewCategory.SECURITY),
        ("  Best-Practices ", ReviewCategory.PATTERN),
        ("dead_code", ReviewCategory.REDUNDANCY),
        ("Testing", ReviewCategory.TEST),
        ("incomplete-fix", ReviewCategory.QUALITY),
        ("vibes", ReviewCategory.QUALITY),
    ],
)
def test_a_model_s_category_maps_to_one_the_app_knows(raw, expected):
    assert map_category(raw) is expected


def test_the_services_package_loads_each_class_on_first_use():
    services = importlib.import_module("runners.github.services")
    engine = services.TriageEngine
    assert (
        engine
        is importlib.import_module("runners.github.services.triage_engine").TriageEngine
    )
    assert services.TriageEngine is engine  # served from the cache the second time
    assert services.PromptManager is PromptManager
    with pytest.raises(AttributeError, match="has no attribute 'Nope'"):
        services.Nope  # noqa: B018

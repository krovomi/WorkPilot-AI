"""The narrative pass must not pay to reproduce prose it already wrote.

Every wiki page is rewritten from the same three source documents. At roughly
20k tokens of sources per page across fourteen pages, one pass costs ~290k
input tokens — about a dollar — and when none of the sources changed, all of
it buys output nobody asked to differ.

The gate is a digest of the sources stored in the wiki. These tests pin its
three interesting cases: skip when nothing changed, still fill a page added
since, and never let a half-finished run claim the wiki is current.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPT = REPO_ROOT / "scripts" / "wiki" / "update_narrative.py"

FILLED = (
    "# Topic\n\n"
    "<!-- AUTOGEN:NARRATIVE:START -->\n"
    "Prose written by an earlier run.\n"
    "<!-- AUTOGEN:NARRATIVE:END -->\n"
)
EMPTY = "# Topic\n\n<!-- AUTOGEN:NARRATIVE:START -->\n<!-- AUTOGEN:NARRATIVE:END -->\n"


@pytest.fixture(scope="module")
def un():
    spec = importlib.util.spec_from_file_location("update_narrative", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def wiki(tmp_path):
    d = tmp_path / "wiki"
    d.mkdir()
    return d


@pytest.fixture
def repo(tmp_path, un):
    """A repo whose source files exist, so `_load_sources` has something."""
    d = tmp_path / "repo"
    (d / "docs").mkdir(parents=True)
    for rel in un.SOURCE_FILES:
        path = d / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f"# {rel}\noriginal content\n", encoding="utf-8")
    return d


def _seal(un, repo, wiki):
    """Record the digest, as a completed run would."""
    digest = un._sources_digest(un._load_sources(repo))
    (wiki / un.SOURCES_DIGEST_FILE).write_text(digest + "\n", encoding="utf-8")


class TestTheGate:
    def test_a_first_run_writes_every_page(self, un, repo, wiki):
        (wiki / "A.md").write_text(FILLED, encoding="utf-8")
        (wiki / "B.md").write_text(FILLED, encoding="utf-8")
        assert un.refresh_narrative("", repo, wiki, dry_run=True) == 2

    def test_unchanged_sources_cost_nothing(self, un, repo, wiki):
        """The whole point: a release that touched no doc pays for no prose."""
        (wiki / "A.md").write_text(FILLED, encoding="utf-8")
        (wiki / "B.md").write_text(FILLED, encoding="utf-8")
        _seal(un, repo, wiki)
        assert un.refresh_narrative("", repo, wiki, dry_run=True) == 0

    def test_a_changed_source_reopens_everything(self, un, repo, wiki):
        (wiki / "A.md").write_text(FILLED, encoding="utf-8")
        _seal(un, repo, wiki)
        (repo / un.SOURCE_FILES[0]).write_text("# changed\n", encoding="utf-8")
        assert un.refresh_narrative("", repo, wiki, dry_run=True) == 1

    def test_a_page_added_since_is_still_filled(self, un, repo, wiki):
        """Sources unchanged, but a new page has nothing to show."""
        (wiki / "Old.md").write_text(FILLED, encoding="utf-8")
        _seal(un, repo, wiki)
        (wiki / "New.md").write_text(EMPTY, encoding="utf-8")
        assert un.refresh_narrative("", repo, wiki, dry_run=True) == 1

    def test_force_overrides_the_gate(self, un, repo, wiki):
        (wiki / "A.md").write_text(FILLED, encoding="utf-8")
        (wiki / "B.md").write_text(FILLED, encoding="utf-8")
        _seal(un, repo, wiki)
        assert un.refresh_narrative("", repo, wiki, dry_run=True, force=True) == 2

    def test_pages_without_the_markers_are_ignored(self, un, repo, wiki):
        (wiki / "Plain.md").write_text("# Just a page\n", encoding="utf-8")
        assert un.refresh_narrative("", repo, wiki, dry_run=True) == 0


class TestTheDigestIsNotWrittenTooEarly:
    def test_a_dry_run_does_not_seal_the_wiki(self, un, repo, wiki):
        """Otherwise a --dry-run would silence the next real run."""
        (wiki / "A.md").write_text(FILLED, encoding="utf-8")
        un.refresh_narrative("", repo, wiki, dry_run=True)
        assert not (wiki / un.SOURCES_DIGEST_FILE).exists()

    def test_a_run_that_raises_leaves_the_wiki_unsealed(
        self, un, repo, wiki, monkeypatch
    ):
        """A half-written pass must not convince the next one it is current."""
        (wiki / "A.md").write_text(FILLED, encoding="utf-8")

        def boom(*_args, **_kwargs):
            raise RuntimeError("claude CLI died")

        monkeypatch.setattr(un, "_call_claude_cli", boom)
        with pytest.raises(RuntimeError):
            un.refresh_narrative("claude", repo, wiki, dry_run=False)
        assert not (wiki / un.SOURCES_DIGEST_FILE).exists()


class TestModelChoice:
    def test_the_narrative_model_is_not_the_dearer_older_one(self, un):
        """Sonnet 4.6 is $3/$15; Sonnet 5 is $2/$10 and newer."""
        assert un.NARRATIVE_MODEL == "claude-sonnet-5"

    def test_translation_stays_on_the_cheapest_model(self, un):
        assert un.TRANSLATE_MODEL == "claude-haiku-4-5"

    @pytest.mark.parametrize("model", ["NARRATIVE_MODEL", "TRANSLATE_MODEL"])
    def test_no_date_suffix_on_a_model_id(self, un, model):
        """A dated variant is not a valid model string."""
        value = getattr(un, model)
        assert not value[-8:].isdigit(), f"{model} carries a date suffix: {value}"

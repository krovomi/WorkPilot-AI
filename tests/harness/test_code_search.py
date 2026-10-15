"""harness.application.code_search: ranked excerpts from one project, and nothing else.

A result names its path, symbol and line range so that a read takes exactly
that range; a cursor reads the next page. The index is rebuilt file by file as
files change. Nothing outside the project is read (S4), an excerpt is masked
for secrets or not returned at all (S1), and the query is only ever words (S2).
"""

from __future__ import annotations

import os
import re
from pathlib import Path

import pytest
from harness.application import code_search
from harness.application.code_search import (
    MAX_RESULTS_ENV,
    RESULTS_ENV,
    index_for,
    list_files,
    resolve_within,
    results_limits,
    search_code,
)

FAKE_KEY = "sk-test00000000000000000000"  # pragma: allowlist secret

BUDGET = '''\
"""Spending caps."""


def over_budget(spent, cap):
    """Whether the spending cap is reached."""
    return spent > cap


def spend(amount, total, cap):
    if over_budget(total + amount, cap):
        raise RuntimeError("cap reached")
    return total + amount
'''

LEDGER = """\
class Ledger:
    def __init__(self):
        self.calls = []

    def record(self, call):
        self.calls.append(call)

    def total(self):
        return sum(call.cost for call in self.calls)
"""

STORE = """\
export function pageItems(items: string[], offset: number): string[] {
  return items.slice(offset);
}
"""

PAGE = 9_000


@pytest.fixture(autouse=True)
def _fresh(monkeypatch):
    code_search.clear_indexes()
    monkeypatch.delenv(RESULTS_ENV, raising=False)
    monkeypatch.delenv(MAX_RESULTS_ENV, raising=False)
    yield
    code_search.clear_indexes()


def _write(root: Path, relative: str, text: str) -> Path:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


@pytest.fixture
def project(temp_git_repo: Path) -> Path:
    _write(temp_git_repo, "app/budget.py", BUDGET)
    _write(temp_git_repo, "app/ledger.py", LEDGER)
    _write(temp_git_repo, "web/store.ts", STORE)
    return temp_git_repo


def _results(text: str) -> list[str]:
    """The location line of each result."""
    return re.findall(r"^\d+\. (\S+:\d+-\d+.*)$", text, re.MULTILINE)


def _search(root: Path, query: str, **kwargs) -> str:
    return search_code(root, query, max_chars=kwargs.pop("max_chars", PAGE), **kwargs)


# --- What comes back ----------------------------------------------------------------


def test_an_identifier_finds_the_chunk_that_defines_it_first(project):
    text = _search(project, "over_budget")
    assert _results(text)[0] == "app/budget.py:4-6 · over_budget (function)"


def test_a_question_in_words_finds_the_code(project):
    assert _results(_search(project, "where is the spending cap checked"))[
        0
    ].startswith("app/budget.py:4-6")


def test_a_result_gives_the_lines_a_read_starts_at(project):
    location = _results(_search(project, "record a call in the ledger"))[0]
    path, first, last = re.match(r"(\S+):(\d+)-(\d+)", location).groups()
    lines = (project / path).read_text(encoding="utf-8").splitlines()
    assert lines[int(first) - 1].strip() == "def record(self, call):"
    assert int(last) == int(first) + 1
    assert "Ledger.record (method)" in location


def test_the_excerpt_shows_numbered_lines(project):
    text = _search(project, "pageItems", limit=1)
    assert (
        "1: export function pageItems(items: string[], offset: number): string[] {"
        in text
    )


def test_nothing_found_says_so(project):
    assert _search(project, "zebra_quantum") == "(no matches)"


# --- Pages and the cursor --------------------------------------------------------------


def test_results_page_with_a_cursor_and_lose_nothing(project):
    first = _search(project, "cap total call", limit=2)
    assert len(_results(first)) == 2
    seen = list(_results(first))
    offset = int(re.search(r"offset=(\d+)", first).group(1))
    assert offset == 2
    while True:
        page = _search(project, "cap total call", limit=2, offset=offset)
        if page == "(no more results)":
            break
        seen += _results(page)
        more = re.search(r"call search_code again with offset=(\d+)", page)
        if not more:
            break
        offset = int(more.group(1))
    everything = _results(_search(project, "cap total call", limit=8))
    assert len(seen) == len(set(seen))
    assert set(everything) <= set(seen)


def test_the_header_counts_the_results(project):
    text = _search(project, "cap total call", limit=2, offset=1)
    assert re.match(r"\[search_code: results 2–3 of \d+\.", text)


def test_the_default_and_the_maximum_are_configurable(project, monkeypatch):
    assert results_limits() == (6, 8)
    monkeypatch.setenv(RESULTS_ENV, "1")
    assert len(_results(_search(project, "cap total call"))) == 1
    monkeypatch.setenv(MAX_RESULTS_ENV, "2")
    monkeypatch.setenv(RESULTS_ENV, "5")
    assert results_limits() == (2, 2)
    assert len(_results(_search(project, "cap total call", limit=50))) == 2
    monkeypatch.setenv(MAX_RESULTS_ENV, "not a number")
    assert results_limits()[1] == 8


def test_a_page_stays_under_its_cap(project):
    _write(project, "app/long.py", "def long_cap():\n" + "    cap = 1\n" * 200)
    text = _search(project, "cap", limit=8, max_chars=1_500)
    assert len(text) <= 1_500


def test_a_page_with_every_note_stays_under_its_cap(project, monkeypatch):
    import docintel.redact as redact

    def unavailable(_text):
        raise redact.ScannerUnavailable("no table")

    monkeypatch.setattr(redact, "redact_text", unavailable)
    monkeypatch.setattr(code_search, "MAX_FILES", 3)
    for n in range(12):
        _write(project, f"app/cap_{n}.py", f"def cap_{n}():\n    return {n}\n")
    text = _search(project, "cap", limit=8, max_chars=1_000)
    assert "code withheld" in text and "the index holds the first" in text
    assert len(text) <= 1_000


# --- The index follows the files ---------------------------------------------------------


def test_a_changed_file_is_read_again_and_a_deleted_one_forgotten(project):
    assert _search(project, "fresh_marker") == "(no matches)"
    _write(project, "app/budget.py", BUDGET + "\n\ndef fresh_marker():\n    return 1\n")
    assert "fresh_marker (function)" in _search(project, "fresh_marker")
    (project / "app/budget.py").unlink()
    assert _search(project, "fresh_marker") == "(no matches)"
    assert "app/budget.py" not in _search(project, "spending cap")


def test_an_unchanged_file_is_not_read_again(project, monkeypatch):
    index = index_for(project)
    index.refresh()
    read: list[Path] = []
    real = code_search._read_text
    monkeypatch.setattr(code_search, "_read_text", lambda p: read.append(p) or real(p))
    index.refresh()
    assert read == []


def test_the_cache_keeps_a_bounded_number_of_projects(tmp_path, monkeypatch):
    monkeypatch.setattr(code_search, "MAX_INDEXES", 2)
    roots = [tmp_path / name for name in ("a", "b", "c")]
    for root in roots:
        root.mkdir()
        index_for(root)
    assert list(code_search._INDEXES) == [str(r.resolve()) for r in roots[1:]]


def test_a_capped_index_says_so_even_when_it_finds_nothing(project, monkeypatch):
    monkeypatch.setattr(code_search, "MAX_FILES", 1)
    text = _search(project, "Test repo")  # the README, the first file listed
    assert "README.md" in text
    assert "the index holds the first 1 files" in text
    empty = _search(project, "over_budget")  # in a file left out
    assert empty.startswith("(no matches)")
    assert "the index holds the first 1 files" in empty


def test_compaction_keeps_results(project, monkeypatch):
    index = index_for(project)
    index.refresh()
    for n in range(3):
        _write(project, "app/budget.py", BUDGET + f"\n# edit {n}\n")
        index.refresh()
    index._compact()
    assert _results(_search(project, "over_budget"))[0].startswith("app/budget.py:4-6")


# --- S4: the project, and only it -----------------------------------------------------------


def test_an_ignored_file_is_not_indexed(project):
    _write(project, ".gitignore", "secret_notes.py\n")
    _write(project, "secret_notes.py", "def ignored_marker():\n    pass\n")
    assert _search(project, "ignored_marker") == "(no matches)"


def test_git_internals_are_never_indexed(project):
    _write(project, ".git/hooks/helper.py", "def git_internal_marker():\n    pass\n")
    assert _search(project, "git_internal_marker") == "(no matches)"


@pytest.mark.parametrize("with_git", [True, False], ids=["git", "walk"])
def test_a_link_out_of_the_project_is_not_followed(
    project, tmp_path_factory, monkeypatch, with_git
):
    if not with_git:
        monkeypatch.setattr(code_search, "_git_files", lambda _root: None)
    outside = tmp_path_factory.mktemp("outside")
    _write(outside, "leak.py", "def outside_marker():\n    pass\n")
    try:
        (project / "linked.py").symlink_to(outside / "leak.py")
        (project / "linked_dir").symlink_to(outside, target_is_directory=True)
    except OSError:
        pytest.skip("symlinks need privileges on this platform")
    assert _search(project, "outside_marker") == "(no matches)"


def test_a_listed_path_that_leaves_the_project_is_refused(
    project, tmp_path_factory, monkeypatch
):
    outside = tmp_path_factory.mktemp("outside")
    leak = _write(outside, "leak.py", "def outside_marker():\n    pass\n")
    escape = os.path.relpath(leak, project).replace(os.sep, "/")
    assert escape.startswith("../")
    monkeypatch.setattr(
        code_search,
        "_git_files",
        lambda _root: [escape, leak.as_posix(), "app/budget.py"],
    )
    assert _search(project, "outside_marker") == "(no matches)"
    assert "over_budget" in _search(project, "over_budget")


def test_resolve_within(project, tmp_path_factory):
    outside = tmp_path_factory.mktemp("outside")
    _write(outside, "x.py", "x = 1\n")
    root = project.resolve()
    assert resolve_within(root, "app/budget.py") == root / "app" / "budget.py"
    for refused in (
        "",
        "../x.py",
        "app/../../x.py",
        "/etc/passwd",
        "app",
        "missing.py",
    ):
        assert resolve_within(root, refused) is None, refused
    try:
        (project / "inside_link.py").symlink_to(project / "app" / "budget.py")
    except OSError:
        pytest.skip("symlinks need privileges on this platform")
    assert resolve_within(root, "inside_link.py") is None  # a link, even inside


def test_binaries_oversized_and_dependency_files_are_skipped(project, monkeypatch):
    monkeypatch.setattr(code_search, "MAX_FILE_BYTES", 400)
    (project / "blob.py").write_bytes(b"def binary_marker():\0\n    pass\n")
    _write(project, "huge.py", "def huge_marker():\n" + "    pass\n" * 100)
    _write(project, "node_modules/dep/index.js", "function dependency_marker() {}\n")
    _write(project, "package-lock.json", '{"lock_marker": 1}\n')
    for marker in ("binary_marker", "huge_marker", "dependency_marker", "lock_marker"):
        assert _search(project, marker) == "(no matches)", marker


def test_without_git_the_walk_skips_hidden_and_dependency_directories(tmp_path):
    _write(tmp_path, "src/main.py", "def main():\n    pass\n")
    _write(tmp_path, ".hidden/x.py", "x = 1\n")
    _write(tmp_path, "node_modules/y.js", "var y;\n")
    _write(tmp_path, "notes.bin", "data\n")
    assert list_files(tmp_path.resolve()) == ["src/main.py"]


# --- S1: an excerpt is masked, or not returned -----------------------------------------------


def test_a_secret_in_an_excerpt_is_masked(project):
    _write(project, "app/config.py", f'API_KEY = "{FAKE_KEY}"\nAPI_URL = "local"\n')
    text = _search(project, "API_KEY")
    assert "app/config.py" in text
    assert FAKE_KEY not in text
    assert "[REDACTED:" in text


def test_without_the_secret_table_no_code_is_returned(project, monkeypatch):
    import docintel.redact as redact

    def unavailable(_text):
        raise redact.ScannerUnavailable("no table")

    monkeypatch.setattr(redact, "redact_text", unavailable)
    _write(project, "app/config.py", f'API_KEY = "{FAKE_KEY}"\n')
    text = _search(project, "API_KEY")
    assert FAKE_KEY not in text
    assert "API_KEY =" not in text
    assert "code withheld" in text
    assert "app/config.py:1-1" in text  # the location stays


# --- S2: the query is words ----------------------------------------------------------------


@pytest.mark.parametrize("query", ["(.*[", "$(rm -rf /)", "'; DROP TABLE x; --"])
def test_a_hostile_query_is_only_words(project, query):
    text = _search(project, query)
    assert isinstance(text, str)


def test_a_path_in_the_query_reads_nothing_outside(project, tmp_path_factory):
    outside = tmp_path_factory.mktemp("outside")
    _write(outside, "leak.py", "def outside_marker():\n    pass\n")
    text = _search(project, f"{outside}/leak.py outside_marker")
    assert "def outside_marker" not in text
    assert "leak.py:" not in text


def test_an_empty_query_is_refused(project):
    with pytest.raises(ValueError):
        _search(project, "   ")
    assert _search(project, "?? !!").startswith("(no word to search for")

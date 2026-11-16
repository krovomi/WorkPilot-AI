"""The documentation cache of `libdocs` (`libdocs/cache.py`): what it serves and what it refuses.

A real cache folder under a temporary project; the clock is the real one,
records are aged by writing their timestamp.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from libdocs import cache as cache_module
from libdocs.cache import MAX_DOC_BYTES, DocsCache, slugify


@pytest.fixture
def cache(tmp_path: Path) -> DocsCache:
    return DocsCache(tmp_path, ttl_days=14)


def _records(cache: DocsCache) -> dict:
    return json.loads(cache.index_path.read_text(encoding="utf-8"))


def _rewrite(cache: DocsCache, **changes) -> None:
    index = _records(cache)
    for record in index.values():
        record.update(changes)
    cache.index_path.write_text(json.dumps(index), encoding="utf-8")


def test_a_stored_page_is_served_back(cache):
    stored = cache.put("/vercel/next.js", "next.js", "app router", "# Routing\n")

    served = cache.get("/vercel/next.js", "app router")

    assert served is not None and served.read() == "# Routing\n"
    assert served.path == stored.path and served.size == len("# Routing\n")
    assert slugify("/vercel/next.js") in served.path.name
    assert [doc.library_name for doc in cache.entries()] == ["next.js"]


def test_an_unknown_question_is_not_served(cache):
    cache.put("/a/b", "b", "q1", "x")

    assert cache.get("/a/b", "q2") is None


def test_a_page_from_before_the_ttl_or_with_an_unreadable_date_is_stale(cache):
    cache.put("/a/b", "b", "q", "x")
    old = (datetime.now(UTC) - timedelta(days=15)).isoformat()

    _rewrite(cache, fetched_at=old)
    assert cache.get("/a/b", "q") is None

    _rewrite(cache, fetched_at="not a date")
    assert cache.get("/a/b", "q") is None


def test_a_naive_timestamp_is_read_as_utc(cache):
    cache.put("/a/b", "b", "q", "x")
    _rewrite(cache, fetched_at=datetime.now(UTC).replace(tzinfo=None).isoformat())

    assert cache.get("/a/b", "q") is not None


def test_a_ttl_of_zero_never_expires(tmp_path):
    forever = DocsCache(tmp_path, ttl_days=0)
    forever.put("/a/b", "b", "q", "x")
    _rewrite(forever, fetched_at="2001-01-01T00:00:00+00:00")

    assert forever.get("/a/b", "q") is not None


@pytest.mark.parametrize(("raw", "days"), [("3", 3), ("", 14), ("soon", 14)])
def test_the_ttl_comes_from_the_environment(tmp_path, monkeypatch, raw, days):
    monkeypatch.setenv("LIBDOCS_TTL_DAYS", raw)

    assert DocsCache(tmp_path).ttl_days == days


def test_a_long_page_is_cut_at_a_line_and_says_so(cache):
    line = "x" * 99 + "\n"
    text = line * (MAX_DOC_BYTES // len(line) + 10)

    body = cache.put("/a/b", "b", "q", text).read()

    assert body.endswith(
        "<!-- truncated by WorkPilot: page exceeded the cache limit -->\n"
    )
    assert body.split("\n\n<!--")[0].endswith("x" * 99)
    assert len(body) <= MAX_DOC_BYTES + 100


def test_a_page_with_no_line_break_is_cut_at_the_limit(cache):
    body = cache.put("/a/b", "b", "q", "y" * (MAX_DOC_BYTES + 5)).read()

    assert body.startswith("y" * MAX_DOC_BYTES + "\n\n<!--")


def test_an_unreadable_or_odd_index_is_an_empty_cache(cache):
    cache.root.mkdir(parents=True)
    cache.index_path.write_text("{broken", encoding="utf-8")
    assert cache.entries() == []

    cache.index_path.write_text("[1, 2]", encoding="utf-8")
    assert cache.entries() == []

    cache.index_path.write_text(json.dumps({"k": "not a record"}), encoding="utf-8")
    assert cache.get("/a/b", "q") is None


@pytest.mark.parametrize(
    "name",
    [
        "",
        None,
        7,
        ".",
        "..",
        "../outside.md",
        "sub/page.md",
        "..\\outside.md",
        "/etc/hosts",
    ],
)
def test_a_record_naming_a_file_outside_the_cache_folder_is_not_served(cache, name):
    cache.put("/a/b", "b", "q", "x")
    (cache.project_dir / "outside.md").write_text("not a page", encoding="utf-8")
    _rewrite(cache, file=name)

    assert cache.get("/a/b", "q") is None
    assert cache.entries() == []


def test_a_link_out_of_the_cache_folder_is_not_served(cache, tmp_path):
    stored = cache.put("/a/b", "b", "q", "x")
    outside = tmp_path / "outside.md"
    outside.write_text("not a page", encoding="utf-8")
    stored.path.unlink()
    try:
        stored.path.symlink_to(outside)
    except OSError:  # Windows without developer mode: nothing to link
        return

    assert cache.get("/a/b", "q") is None


def test_an_odd_size_reads_as_zero(cache):
    cache.put("/a/b", "b", "q", "x")
    _rewrite(cache, size="big")

    assert cache.get("/a/b", "q").size == 0


def test_a_page_whose_file_cannot_be_read_reads_empty(cache, monkeypatch):
    doc = cache.put("/a/b", "b", "q", "x")

    def refuse(self, *args, **kwargs):
        raise PermissionError(self)

    monkeypatch.setattr(Path, "read_text", refuse)

    assert doc.read() == ""


def test_prune_drops_expired_and_broken_entries_and_keeps_fresh_ones(cache):
    fresh = cache.put("/a/fresh", "fresh", "q", "x")
    stale = cache.put("/a/stale", "stale", "q", "x")
    index = _records(cache)
    for record in index.values():
        if record["library_id"] == "/a/stale":
            record["fetched_at"] = "2001-01-01T00:00:00+00:00"
    index["broken"] = {"file": ""}
    cache.index_path.write_text(json.dumps(index), encoding="utf-8")

    assert cache.prune() == 2
    assert fresh.path.exists() and not stale.path.exists()
    assert [doc.library_id for doc in cache.entries()] == ["/a/fresh"]
    assert cache.prune() == 0


def test_prune_goes_on_when_a_page_cannot_be_deleted(cache, monkeypatch):
    doc = cache.put("/a/b", "b", "q", "x")
    _rewrite(cache, fetched_at="2001-01-01T00:00:00+00:00")

    def locked(self, missing_ok=False):
        raise PermissionError(self)

    monkeypatch.setattr(Path, "unlink", locked)

    assert cache.prune() == 1
    assert doc.path.exists()
    assert _records(cache) == {}


def test_a_failed_write_leaves_no_temporary_file(cache, monkeypatch):
    cache.root.mkdir(parents=True)

    def full(_source, _target):
        raise OSError("disk full")

    monkeypatch.setattr(cache_module.os, "replace", full)

    with pytest.raises(OSError, match="disk full"):
        cache.put("/a/b", "b", "q", "x")
    assert [p.name for p in cache.root.iterdir()] == []


def test_a_temporary_file_that_cannot_be_removed_does_not_hide_the_failure(
    cache, monkeypatch
):
    def full(_source, _target):
        raise OSError("disk full")

    def stuck(_path):
        raise PermissionError("locked")

    monkeypatch.setattr(cache_module.os, "replace", full)
    monkeypatch.setattr(cache_module.os, "unlink", stuck)

    with pytest.raises(OSError, match="disk full"):
        cache.put("/a/b", "b", "q", "x")


@pytest.mark.parametrize(
    ("raw", "slug"),
    [("/vercel/next.js", "vercel-next.js"), ("///", "library"), ("/A/B v2", "a-b-v2")],
)
def test_a_library_id_becomes_one_flat_file_name(raw, slug):
    assert slugify(raw) == slug

"""A card's captures summary and published copies read from odd files on disk.

The routes are tested in `test_shared_board_captures.py`; these are the
files a broken or tampered build could leave: one too large, a list where a
word was expected, a copy that cannot be read.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from shared_board import captures

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16


def _spec(tmp_path: Path, publication: object) -> Path:
    spec = tmp_path / "001-x"
    folder = spec / "captures"
    (folder / "published" / "task").mkdir(parents=True)
    (folder / "publication.json").write_text(json.dumps(publication), encoding="utf-8")
    return spec


def _item(**overrides) -> dict:
    item = {
        "key": "web|orders|",
        "label": "orders",
        "platform": "web",
        "after": {
            "file": "captures/published/task/web--orders.png",
            "signature": "1:1",
            "publishable": True,
            "privacy": {"status": "clean", "kinds": "email", "checks": None},
        },
        "publishable": True,
    }
    item.update(overrides)
    return item


def test_a_publication_too_large_to_read_is_no_publication(tmp_path, monkeypatch):
    spec = _spec(tmp_path, {"version": 1, "items": [_item()]})
    monkeypatch.setattr(captures, "MAX_JSON_BYTES", 10)
    assert captures.summary(spec)["items"] == []
    assert captures.summary(spec)["needed"] is False


def test_lists_that_are_not_lists_and_rows_that_are_not_items_are_skipped(tmp_path):
    spec = _spec(
        tmp_path,
        {
            "version": 1,
            "decision": {"needed": True},
            "settings": {"publish": "review"},
            "items": ["noise", _item(), {"publishable": False}, 3],
        },
    )
    summary = captures.summary(spec)
    assert [i["key"] for i in summary["items"]] == ["web|orders|", ""]
    after = summary["items"][0]["after"]
    assert (after["kinds"], after["passes"]) == ([], [])
    # Nothing approved yet: the one publishable copy waits for a person.
    assert summary["approved"] is False


def test_a_copy_that_cannot_be_read_or_is_too_large_is_not_served(
    tmp_path, monkeypatch
):
    spec = _spec(tmp_path, {"version": 1, "items": [_item()]})
    copy = spec / "captures" / "published" / "task" / "web--orders.png"
    copy.write_bytes(PNG)
    assert captures.published_copy(spec, 0, "after") == PNG
    monkeypatch.setattr(captures, "MAX_IMAGE_BYTES", 4)
    assert captures.published_copy(spec, 0, "after") is None
    monkeypatch.undo()
    real = Path.read_bytes

    def read_bytes(self):
        if self.name == copy.name:
            raise PermissionError("locked")
        return real(self)

    monkeypatch.setattr(Path, "read_bytes", read_bytes)
    assert captures.published_copy(spec, 0, "after") is None


@pytest.mark.parametrize("value", [None, "email", {"a": 1}, 3])
def test_words_come_only_from_a_list(value):
    assert captures._words(value) == []

"""The vault's images on the paths the round trips in ``test_brain_images`` do
not take: files that vanish or cannot be read mid-walk, a cache that cannot be
written, and what an engine answers that is not worth indexing."""

from __future__ import annotations

import json
import os
import struct
import zlib
from pathlib import Path

import pytest
from brain import images
from brain.images import cache_path, index_images, iter_images
from docintel import engines as engines_pkg
from docintel import redact
from docintel.engines.base import OcrOutcome


def png(seed: int) -> bytes:
    raw = b"".join(b"\x00" + bytes([seed % 256, 0, 0]) * 2 for _ in range(2))

    def chunk(kind: bytes, data: bytes) -> bytes:
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", 2, 2, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )


class Engine:
    name = "tesseract"
    local = True
    preview = True

    def __init__(self, texts: dict[str, str]) -> None:
        self.texts = texts
        self.calls: list[str] = []

    def available(self, env):
        return None

    def recognize(self, image: Path, langs, env) -> OcrOutcome:
        self.calls.append(image.name)
        text = self.texts.get(image.name, "")
        return OcrOutcome(text=text, reason="" if text else "empty")


@pytest.fixture(autouse=True)
def _isolated(monkeypatch):
    for key in (
        images.ENABLED_ENV,
        images.MAX_IMAGES_ENV,
        images.PER_BUILD_ENV,
        "DOCINTEL_OCR_ENGINE",
        "DOCINTEL_MAX_BYTES",
    ):
        monkeypatch.delenv(key, raising=False)


@pytest.fixture
def engine(monkeypatch):
    def install(texts: dict[str, str]) -> Engine:
        fake = Engine(texts)
        monkeypatch.setattr(engines_pkg, "ENGINES", {fake.name: fake})
        return fake

    return install


@pytest.fixture
def vault(tmp_path):
    root = tmp_path / "vault"
    (root / "assets").mkdir(parents=True)
    return root


def put(root: Path, name: str, seed: int) -> Path:
    path = root / "assets" / name
    path.write_bytes(png(seed))
    return path


def cached(root: Path) -> dict:
    return json.loads(cache_path(root).read_text(encoding="utf-8"))


class TestWalk:
    def test_the_walk_stops_at_its_limit(self, vault):
        for n in range(3):
            put(vault, f"s{n}.png", n)
        assert [p.name for p in iter_images(vault, limit=2)] == ["s0.png", "s1.png"]

    def test_a_file_whose_place_cannot_be_resolved_is_skipped(self, vault, monkeypatch):
        put(vault, "a.png", 1)
        odd = put(vault, "odd.png", 2)
        real = Path.resolve

        def unresolvable(self, *args, **kwargs):
            if self.name == odd.name:
                raise OSError("too many levels of links")
            return real(self, *args, **kwargs)

        monkeypatch.setattr(Path, "resolve", unresolvable)

        assert [p.name for p in iter_images(vault)] == ["a.png"]


class TestWhatIsRead:
    def test_blank_text_long_text_and_no_text(self, vault, engine):
        put(vault, "blank.png", 1)
        put(vault, "long.png", 2)
        put(vault, "none.png", 3)
        engine({"blank.png": "   \n ", "long.png": "word " * 1000})

        found = {i.rel.rsplit("/", 1)[-1]: i for i in index_images(vault)}

        assert (found["blank.png"].status, found["blank.png"].text) == ("empty", "")
        assert found["long.png"].text.endswith("…")
        assert len(found["long.png"].text) == images.MAX_TEXT_CHARS
        assert (found["none.png"].status, found["none.png"].reason) == (
            "empty",
            "empty",
        )
        assert found["none.png"].engine == "tesseract"

    def test_text_the_scanner_cannot_vet_is_withheld(self, vault, engine, monkeypatch):
        put(vault, "a.png", 1)
        engine({"a.png": "Deploy with make release"})

        def unavailable(_text):
            raise redact.ScannerUnavailable("no scanner")

        monkeypatch.setattr(redact, "redact_text", unavailable)

        [image] = index_images(vault)

        assert (image.status, image.text) == ("withheld", "")

    def test_a_drawing_without_shapes_is_empty_not_ocr(self, vault, engine):
        (vault / "assets" / "blank.svg").write_text(
            '<svg xmlns="http://www.w3.org/2000/svg"/>', encoding="utf-8"
        )
        fake = engine({})

        [image] = index_images(vault)

        assert (image.status, image.reason) == ("empty", "no-diagram")
        assert fake.calls == []

    def test_a_file_over_the_size_limit_is_not_read(self, vault, engine, monkeypatch):
        put(vault, "big.png", 1)
        monkeypatch.setenv("DOCINTEL_MAX_BYTES", "10")
        fake = engine({"big.png": "x"})

        [image] = index_images(vault)

        assert (image.status, image.reason) == ("empty", "too-large")
        assert fake.calls == []


class TestFilesThatGoAway:
    def test_a_file_gone_before_it_is_measured(self, vault, engine, monkeypatch):
        put(vault, "a.png", 1)
        engine({"a.png": "kept"})
        monkeypatch.setattr(
            images,
            "iter_images",
            lambda root, limit=None: [Path("assets/gone.png"), Path("assets/a.png")],
        )

        assert [i.rel for i in index_images(vault)] == ["assets/a.png"]

    def test_a_file_that_cannot_be_read(self, vault, engine, monkeypatch):
        put(vault, "a.png", 1)
        busy = put(vault, "busy.png", 2)
        engine({"a.png": "kept", "busy.png": "lost"})
        real = Path.read_bytes

        def locked(self):
            if self.name == busy.name:
                raise PermissionError("locked")
            return real(self)

        monkeypatch.setattr(Path, "read_bytes", locked)

        assert [i.rel for i in index_images(vault)] == ["assets/a.png"]

    def test_a_known_file_that_cannot_be_read_when_its_turn_comes(
        self, vault, engine, monkeypatch
    ):
        put(vault, "a.png", 1)
        engine({"a.png": "later"})
        monkeypatch.setenv(images.PER_BUILD_ENV, "0")
        [queued] = index_images(vault)  # measured and hashed, not read
        assert queued.status == "pending"
        monkeypatch.setenv(images.PER_BUILD_ENV, "5")

        def locked(self):
            raise PermissionError("locked")

        monkeypatch.setattr(Path, "read_bytes", locked)

        assert index_images(vault) == []

    def test_what_no_image_points_at_is_forgotten(self, vault, engine):
        put(vault, "a.png", 1)
        b = put(vault, "b.png", 2)
        engine({"a.png": "first", "b.png": "second"})
        index_images(vault)
        assert len(cached(vault)["entries"]) == 2

        b.unlink()
        index_images(vault)

        assert [e["text"] for e in cached(vault)["entries"].values()] == ["first"]


class TestCache:
    def test_a_cache_folder_that_is_a_link_is_not_written(
        self, vault, engine, tmp_path
    ):
        elsewhere = tmp_path / "elsewhere"
        elsewhere.mkdir()
        try:
            (vault / cache_path(vault).parent.name).symlink_to(
                elsewhere, target_is_directory=True
            )
        except OSError:
            pytest.skip("symbolic links are not available here")
        put(vault, "a.png", 1)
        engine({"a.png": "text"})

        [image] = index_images(vault)

        assert image.status == "text" and list(elsewhere.iterdir()) == []

    def test_a_cache_that_cannot_be_written_leaves_nothing_behind(
        self, vault, engine, monkeypatch, caplog
    ):
        put(vault, "a.png", 1)
        engine({"a.png": "text"})

        def full(*_a, **_k):
            raise OSError("disk full")

        monkeypatch.setattr(images.json, "dump", full)

        with caplog.at_level("DEBUG", logger="brain.images"):
            [image] = index_images(vault)

        assert image.status == "text"
        assert "could not write the OCR cache" in caplog.text
        assert os.listdir(cache_path(vault).parent) == []

    def test_indexing_that_breaks_leaves_the_graph_its_notes(
        self, vault, monkeypatch, caplog
    ):
        def broken(*_a, **_k):
            raise RuntimeError("a bug in a reader")

        monkeypatch.setattr(images, "iter_images", broken)

        with caplog.at_level("DEBUG", logger="brain.images"):
            assert index_images(vault) == []
        assert "image indexing failed" in caplog.text


def test_no_vault_has_no_images(tmp_path):
    assert list(iter_images(tmp_path / "none")) == []

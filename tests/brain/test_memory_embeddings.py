"""A local embeddings model finds memory conflicts in other words (#352).

The lexical detector needs words in common; "always run the migrations before
the tests" against "never apply schema changes ahead of the test suite" has
none. When Ollama already has an embeddings model, a sync's review asks it,
and keeps the pairs that read as one subject and disagree. These tests hold,
against a fake Ollama on the loopback (no real model):

* model present: the pair is found, queued like the others, marked
  ``found_by: embeddings``;
* no model, endpoint down, a timeout, a malformed answer: lexical only, and
  no error;
* a vector is cached per note statement, and the next review sends nothing;
* at most ``MAX_EMBEDDED`` notes are sent in one review;
* notes in disjoint scopes are never sent nor paired;
* nothing is ever pulled, and only a loopback endpoint is asked;
* the switch and the model live in the brain settings, the variable winning.
"""

from __future__ import annotations

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from brain import api as brain_api
from brain.home import write_config
from brain.lifecycle import arbitration, contradictions, embeddings
from brain.lifecycle.contradictions import compare, compare_meaning, find_for
from brain.notes import Note, write_note

BASE = "knowledge/projects/shop/memory"
OURS = "Always run the migrations before the tests."
THEIRS = "Never apply schema changes ahead of the test suite."
OTHER = "Keep the changelog entries in French."


def _topic(text: str) -> list[float]:
    """The fake model: notes on the database schema point one way."""
    low = text.lower()
    if "migration" in low or "schema" in low:
        return [1.0, 0.05, 0.0]
    if "prisma" in low or "drizzle" in low:
        return [0.0, 1.0, 0.05]
    return [0.0, 0.0, 1.0]


class FakeOllama:
    def __init__(self) -> None:
        self.models = [{"name": "nomic-embed-text:latest"}, {"name": "llama3:8b"}]
        self.embedded: list[str] = []
        self.pulls = 0
        self.delay = 0.0
        self.status = 200
        self.answer: object | None = None
        self.redirect = False
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):  # quiet
                pass

            def _send(self, payload: object, status: int = 200) -> None:
                body = json.dumps(payload).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                if outer.redirect:
                    self.send_response(302)
                    self.send_header("Location", "http://example.com/api/tags")
                    self.end_headers()
                    return
                self._send({"models": outer.models})

            def do_POST(self):
                length = int(self.headers.get("Content-Length") or 0)
                request = json.loads(self.rfile.read(length).decode("utf-8"))
                if self.path == "/api/pull":
                    outer.pulls += 1
                    self._send({"status": "refused"}, 403)
                    return
                if outer.delay:
                    time.sleep(outer.delay)
                texts = request["input"]
                outer.embedded.extend(texts)
                if outer.status != 200:
                    self._send({"error": "boom"}, outer.status)
                    return
                answer = (
                    outer.answer
                    if outer.answer is not None
                    else {"embeddings": [_topic(t) for t in texts]}
                )
                self._send(answer)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def ollama(monkeypatch):
    fake = FakeOllama()
    monkeypatch.setenv("OLLAMA_BASE_URL", fake.url)
    monkeypatch.delenv(embeddings.SWITCH_ENV, raising=False)
    monkeypatch.delenv(embeddings.MODEL_ENV, raising=False)
    monkeypatch.delenv("BRAIN_CONFLICT_STALE_DAYS", raising=False)
    yield fake
    fake.close()


def put(root: Path, name: str, body: str, folder: str = "gotchas", **meta) -> str:
    rel = f"{BASE}/{folder}/{name}.md"
    write_note(root, Note(path=Path(rel), meta={"project": "shop", **meta}, body=body))
    return rel


def queue(root: Path) -> list[dict]:
    path = root / arbitration.QUEUE_FILE
    return json.loads(path.read_text(encoding="utf-8"))["open"] if path.exists() else []


# --------------------------------------------------------------------------- #
# Through a sync's review
# --------------------------------------------------------------------------- #


class TestReview:
    def test_the_pair_in_other_words_is_found_and_marked(self, tmp_path, ollama):
        assert compare(OURS, THEIRS) is None  # no word in common
        ours = put(tmp_path, "ours", OURS)
        put(tmp_path, "other", OTHER)
        theirs = put(tmp_path, "theirs", THEIRS)

        summary = arbitration.review_pull(tmp_path, [theirs], [])

        assert summary == {"checked": 1, "auto": 0, "queued": 1}
        [item] = queue(tmp_path)
        assert item["found_by"] == "embeddings" and item["signal"] == "negation"
        assert {item["a"]["path"], item["b"]["path"]} == {ours, theirs}
        assert item["detail"].startswith("≈ ")
        assert ollama.pulls == 0
        assert (tmp_path / embeddings.CACHE_FILE).is_file()

    def test_a_lexical_pair_says_so(self, tmp_path, ollama):
        put(tmp_path, "ours", "Use Prisma for the billing module.")
        theirs = put(tmp_path, "theirs", "Use Drizzle for the billing module.")

        arbitration.review_pull(tmp_path, [theirs], [])

        [item] = queue(tmp_path)
        assert item["found_by"] == "lexical" and item["signal"] == "recommendation"

    @pytest.mark.parametrize("trouble", ["no-model", "down", "timeout", "garbled"])
    def test_without_the_model_it_is_lexical_only(
        self, tmp_path, ollama, monkeypatch, trouble
    ):
        if trouble == "no-model":
            ollama.models = [{"name": "llama3:8b"}]
        elif trouble == "down":
            ollama.close()
        elif trouble == "timeout":
            monkeypatch.setattr(embeddings, "EMBED_TIMEOUT_S", 0.2)
            ollama.delay = 1.0
        else:
            ollama.answer = {"embeddings": [[1.0]]}  # one vector for two texts
        put(tmp_path, "ours", OURS)
        theirs = put(tmp_path, "theirs", THEIRS)

        summary = arbitration.review_pull(tmp_path, [theirs], [])

        assert summary == {"checked": 0, "auto": 0, "queued": 0}
        assert queue(tmp_path) == []

    def test_the_next_review_reads_the_cache(self, tmp_path, ollama):
        put(tmp_path, "ours", OURS)
        theirs = put(tmp_path, "theirs", THEIRS)
        arbitration.review_pull(tmp_path, [theirs], [])
        sent = len(ollama.embedded)
        assert sent == 2
        (tmp_path / arbitration.QUEUE_FILE).unlink()

        arbitration.review_pull(tmp_path, [theirs], [])

        assert len(ollama.embedded) == sent  # nothing sent again
        assert len(queue(tmp_path)) == 1

    def test_at_most_the_cap_is_sent(self, tmp_path, ollama, monkeypatch):
        monkeypatch.setattr(embeddings, "MAX_EMBEDDED", 3)
        monkeypatch.setattr(embeddings, "BATCH", 2)
        for n in range(6):
            put(tmp_path, f"n{n}", f"Note number {n} about the release train.")
        theirs = put(tmp_path, "theirs", THEIRS)

        arbitration.review_pull(tmp_path, [theirs], [])

        assert len(ollama.embedded) == 3
        assert ollama.embedded[0] == THEIRS  # the received note first

    def test_disjoint_scopes_are_neither_sent_nor_paired(self, tmp_path, ollama):
        put(tmp_path, "ours", OURS, applies_to="team:payments")
        theirs = put(tmp_path, "theirs", THEIRS, applies_to="team:billing")

        arbitration.review_pull(tmp_path, [theirs], [])

        assert ollama.embedded == [] and queue(tmp_path) == []

    def test_switched_off_nothing_is_asked(self, tmp_path, ollama, monkeypatch):
        monkeypatch.setenv(embeddings.SWITCH_ENV, "off")
        put(tmp_path, "ours", OURS)
        theirs = put(tmp_path, "theirs", THEIRS)

        arbitration.review_pull(tmp_path, [theirs], [])

        assert ollama.embedded == [] and queue(tmp_path) == []

    def test_a_secret_in_a_note_is_not_sent(self, tmp_path, ollama):
        put(tmp_path, "ours", OURS)
        token = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"
        theirs = put(tmp_path, "theirs", f"{THEIRS} Token {token}")

        arbitration.review_pull(tmp_path, [theirs], [])

        assert ollama.embedded and not any(token in t for t in ollama.embedded)


# --------------------------------------------------------------------------- #
# The detector's semantic rule
# --------------------------------------------------------------------------- #


class TestCompareMeaning:
    def test_below_the_threshold_nothing(self):
        assert compare_meaning(OURS, THEIRS, contradictions.SIMILAR - 0.01) is None

    def test_one_says_not_to(self):
        found = compare_meaning(OURS, THEIRS, 0.91)
        assert found is not None and found.signal == "negation"
        assert found.found_by == "embeddings" and found.detail == "≈ 0.91"

    def test_two_recommendations(self):
        found = compare_meaning(
            "Prefer Prisma in billing.", "Use Drizzle in the payments code.", 0.85
        )
        assert found is not None and found.signal == "recommendation"
        assert found.detail == "prisma ≠ drizzle (≈ 0.85)"

    def test_agreeing_notes_are_not_a_conflict(self):
        assert compare_meaning(OURS, "Apply schema changes before tests.", 0.95) is None

    def test_disjoint_scopes_never_clash(self):
        a = Note(path=Path("a.md"), meta={"applies_to": "auth/"}, body=OURS)
        b = Note(path=Path("b.md"), meta={"applies_to": "payments/"}, body=THEIRS)
        assert compare_meaning(a, b, 0.99) is None

    def test_find_for_without_a_vector_for_the_note(self, tmp_path, ollama):
        put(tmp_path, "ours", OURS)
        theirs = put(tmp_path, "theirs", THEIRS)
        embedder = embeddings.open_embedder(tmp_path)
        assert embedder is not None
        embedder.budget = 0

        assert find_for(tmp_path, BASE, theirs, embedder) == []

    def test_find_for_without_a_vector_for_the_other(self, tmp_path, ollama):
        put(tmp_path, "ours", OURS)
        theirs = put(tmp_path, "theirs", THEIRS)
        embedder = embeddings.open_embedder(tmp_path)
        assert embedder is not None
        embedder.budget = 1

        assert find_for(tmp_path, BASE, theirs, embedder) == []


# --------------------------------------------------------------------------- #
# The client, its cache and its settings
# --------------------------------------------------------------------------- #


class TestModelChoice:
    TAGS = {
        "models": [
            {"name": "llama3:8b"},
            {"name": "all-minilm:latest"},
            {"name": "nomic-embed-text:latest"},
            {"name": "bge-m3:cloud"},
            {"name": "mxbai-embed-large", "remote_host": "https://x"},
            "not a model",
            {"name": 3},
            {"name": "bad name with spaces-embed"},
        ]
    }

    def test_the_preferred_pulled_model_wins(self):
        assert embeddings.pick_model(self.TAGS) == "nomic-embed-text:latest"

    def test_another_embedding_model_is_taken_too(self):
        assert (
            embeddings.pick_model({"models": [{"name": "all-minilm"}]}) == "all-minilm"
        )

    def test_a_named_model_is_used_only_when_pulled(self):
        assert embeddings.pick_model(self.TAGS, "all-minilm") == "all-minilm:latest"
        assert embeddings.pick_model(self.TAGS, "llama3:8b") == "llama3:8b"
        assert embeddings.pick_model(self.TAGS, "bge-m3") is None  # cloud only
        assert embeddings.pick_model(self.TAGS, "e5-large") is None

    @pytest.mark.parametrize("tags", [None, [], {"models": None}, {"models": []}])
    def test_nothing_to_pick(self, tags):
        assert embeddings.pick_model(tags) is None


class TestSettings:
    def test_the_variable_wins_over_the_config(self, monkeypatch):
        write_config(conflictEmbeddings=False, conflictEmbeddingsModel="bge-m3")
        monkeypatch.delenv(embeddings.SWITCH_ENV, raising=False)
        assert embeddings.enabled() is False
        assert embeddings.configured_model() == "bge-m3"
        monkeypatch.setenv(embeddings.SWITCH_ENV, "on")
        monkeypatch.setenv(embeddings.MODEL_ENV, "all-minilm")
        assert embeddings.enabled() is True
        assert embeddings.configured_model() == "all-minilm"

    def test_on_by_default_and_a_bad_name_is_ignored(self, monkeypatch):
        monkeypatch.delenv(embeddings.SWITCH_ENV, raising=False)
        monkeypatch.delenv(embeddings.MODEL_ENV, raising=False)
        write_config(conflictEmbeddingsModel=["not", "a", "name"])
        assert embeddings.enabled() is True and embeddings.configured_model() == ""
        monkeypatch.setenv(embeddings.MODEL_ENV, "x; rm -rf /")
        assert embeddings.configured_model() == ""

    def test_a_remote_endpoint_is_never_asked(self, monkeypatch, tmp_path):
        monkeypatch.delenv(embeddings.SWITCH_ENV, raising=False)
        monkeypatch.setenv("OLLAMA_BASE_URL", "http://10.1.2.3:11434")
        assert embeddings.open_embedder(tmp_path) is None

    def test_a_redirect_is_not_followed(self, tmp_path, ollama):
        ollama.redirect = True
        assert embeddings.open_embedder(tmp_path) is None

    def test_an_answer_too_large_is_refused(self, tmp_path, ollama, monkeypatch):
        monkeypatch.setattr(embeddings, "MAX_RESPONSE", 10)
        assert embeddings.open_embedder(tmp_path) is None

    def test_an_error_status_stops_the_review(self, tmp_path, ollama):
        ollama.status = 500
        embedder = embeddings.open_embedder(tmp_path)
        assert embedder is not None
        assert embedder.vectors(["a", "b"]) == [None, None]
        assert embedder.down and embedder.vectors(["c"]) == [None]
        assert len(ollama.embedded) == 2


class TestVectors:
    @pytest.mark.parametrize(
        "value",
        [None, [], "x", [1, "2"], [True, 1.0], [float("inf")], [0.0] * 9000],
    )
    def test_a_malformed_vector_is_dropped(self, value):
        assert embeddings._vector(value) is None

    def test_a_vector_is_read_as_floats(self):
        assert embeddings._vector([1, 2.5]) == [1.0, 2.5]

    @pytest.mark.parametrize("value", [None, 3, "!!!", "", "AAA=", "A" * 70000])
    def test_a_malformed_cache_entry_is_dropped(self, value):
        assert embeddings._unpack(value) is None

    def test_a_cache_entry_round_trips(self):
        assert embeddings._unpack(embeddings._pack([1.0, -0.5])) == [1.0, -0.5]

    def test_cosine(self):
        assert embeddings.similarity([1.0, 0.0], [1.0, 0.0]) == pytest.approx(1.0)
        assert embeddings.similarity([1.0, 0.0], [1.0]) == 0.0
        assert embeddings.similarity([0.0, 0.0], [1.0, 0.0]) == 0.0


class TestCache:
    def test_a_duplicate_text_is_sent_once(self, tmp_path, ollama):
        embedder = embeddings.open_embedder(tmp_path)
        assert embedder is not None
        first, second = embedder.vectors([OURS, OURS])
        assert first == second and first is not None
        assert ollama.embedded == [OURS] and embedder.sent == 1

    def test_a_malformed_vector_in_the_answer_is_not_kept(self, tmp_path, ollama):
        ollama.answer = {"embeddings": [[1.0, 0.0], "not a vector"]}
        embedder = embeddings.open_embedder(tmp_path)
        assert embedder is not None
        assert embedder.vectors(["one", "two"]) == [[1.0, 0.0], None]
        assert list(embedder._cache) == [embedder._key("one")]

    def test_a_bad_cache_file_is_ignored(self, tmp_path, ollama):
        cache = tmp_path / embeddings.CACHE_FILE
        cache.parent.mkdir(parents=True)
        for content in ("not json", "[]", '{"vectors": []}'):
            cache.write_text(content, encoding="utf-8")
            embedder = embeddings.open_embedder(tmp_path)
            assert embedder is not None and embedder._cache == {}
        cache.write_text('{"vectors": {"k": 3, "j": "AACAPw=="}}', encoding="utf-8")
        embedder = embeddings.open_embedder(tmp_path)
        assert embedder is not None and embedder._cache == {"j": "AACAPw=="}

    def test_the_cache_keeps_the_most_recent(self, tmp_path, ollama, monkeypatch):
        monkeypatch.setattr(embeddings, "MAX_CACHED", 2)
        embedder = embeddings.open_embedder(tmp_path)
        assert embedder is not None
        embedder.vectors(["one", "two", "three"])
        embedder.save()
        data = json.loads((tmp_path / embeddings.CACHE_FILE).read_text("utf-8"))
        assert list(data["vectors"]) == [embedder._key("two"), embedder._key("three")]

    def test_nothing_new_nothing_written(self, tmp_path, ollama):
        embedder = embeddings.open_embedder(tmp_path)
        assert embedder is not None
        embedder.save()
        assert not (tmp_path / embeddings.CACHE_FILE).exists()

    def test_a_cache_that_cannot_be_written(self, tmp_path, ollama):
        (tmp_path / ".workpilot-brain").write_text("a file", encoding="utf-8")
        embedder = embeddings.open_embedder(tmp_path)
        assert embedder is not None
        assert embedder.vectors([OURS])[0] is not None
        embedder.save()  # logged, not raised

    def test_a_cache_outside_the_brain_is_not_used(self, tmp_path, ollama):
        outside = tmp_path / "elsewhere"
        outside.mkdir()
        root = tmp_path / "brain"
        root.mkdir()
        try:
            (root / ".workpilot-brain").symlink_to(outside, target_is_directory=True)
        except OSError:
            pytest.skip("symbolic links are not available here")
        embedder = embeddings.open_embedder(root)
        assert embedder is not None and embedder._path is None
        assert embedder.vectors([OURS])[0] is not None
        embedder.save()
        assert list(outside.iterdir()) == []


# --------------------------------------------------------------------------- #
# Settings screen
# --------------------------------------------------------------------------- #


@pytest.fixture
def client(tmp_path, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    monkeypatch.setenv("WORKPILOT_BRAIN_CONFIG", str(tmp_path / "brain.json"))
    monkeypatch.delenv(embeddings.SWITCH_ENV, raising=False)
    monkeypatch.delenv(embeddings.MODEL_ENV, raising=False)
    app = FastAPI()
    app.include_router(brain_api.router)
    return TestClient(app)


def post(client, body: dict) -> dict:
    return client.post("/api/brain/settings", json={"connect": False, **body}).json()


class TestSettingsRoute:
    def test_the_view_and_a_save(self, client, tmp_path):
        reply = post(
            client,
            {"conflict_embeddings": False, "conflict_embeddings_model": " bge-m3 "},
        )
        assert reply["success"] is True
        assert reply["settings"]["conflictEmbeddings"] == {
            "enabled": False,
            "model": "bge-m3",
            "enabledLocked": False,
            "modelLocked": False,
        }
        reply = post(client, {"conflict_embeddings_model": ""})
        assert reply["settings"]["conflictEmbeddings"]["model"] == ""
        saved = json.loads((tmp_path / "brain.json").read_text(encoding="utf-8"))
        assert saved == {"conflictEmbeddings": False}

    def test_a_bad_model_name_is_refused(self, client):
        reply = post(client, {"conflict_embeddings_model": "../../etc"})
        assert reply["success"] is False and reply["code"] == "invalid-model"

    @pytest.mark.parametrize(
        ("variable", "body"),
        [
            (embeddings.SWITCH_ENV, {"conflict_embeddings": True}),
            (embeddings.MODEL_ENV, {"conflict_embeddings_model": "bge-m3"}),
        ],
    )
    def test_a_variable_locks_its_setting(self, client, monkeypatch, variable, body):
        monkeypatch.setenv(
            variable, "off" if variable == embeddings.SWITCH_ENV else "x"
        )
        reply = post(client, body)
        assert reply["success"] is False and reply["code"] == "env-locked"


def test_the_cache_is_git_ignored():
    from brain import sync

    assert sync._IGNORED[-1] == embeddings.CACHE_FILE

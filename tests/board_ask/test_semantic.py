"""Ranking the tickets of a board by meaning (board_ask.semantic, its runner)."""

from __future__ import annotations

import json
import math
from pathlib import Path

import pytest
from board_ask import semantic
from board_ask.semantic import (
    CLOUDS,
    CloudEmbedder,
    Source,
    endpoint_base,
    parse_request,
    rank,
    resolve,
)
from brain.lifecycle.embeddings import Embedder, Found

VECTORS = {
    "admin": [1.0, 0.0, 0.0],
    "admin page review": [0.9, 0.1, 0.0],
    "revisión del panel de administración": [0.95, 0.05, 0.0],
    "csv export": [0.0, 1.0, 0.0],
    "login": [0.0, 0.0, 1.0],
}


def _vector_of(text: str) -> list[float]:
    for prefix in ("query: ", "passage: "):
        text = text.removeprefix(prefix)
    return VECTORS.get(text, [0.3, 0.3, 0.3])


class FakeApi:
    """The embeddings API, as `_post` sees it."""

    def __init__(self, style: str = "openai") -> None:
        self.style = style
        self.calls: list[tuple[str, dict, str]] = []
        self.fail = False

    def __call__(self, url: str, payload: dict, key: str, timeout: float):
        self.calls.append((url, payload, key))
        if self.fail:
            raise OSError("down")
        texts = payload["inputs"] if self.style == "huggingface" else payload["input"]
        if self.style == "huggingface":
            return [_vector_of(t) for t in texts]
        data = [{"embedding": _vector_of(t), "index": i} for i, t in enumerate(texts)]
        return {"data": list(reversed(data))}


@pytest.fixture
def api(monkeypatch):
    fake = FakeApi()
    monkeypatch.setattr(semantic, "_post", fake)
    monkeypatch.setattr(semantic, "find", lambda: None)
    return fake


def _env(**extra: str) -> dict[str, str]:
    return {
        "SELECTED_LLM_PROVIDER": "openai",
        "OPENAI_API_KEY": "sk-test-0000",
        **extra,
    }


DOCS = [
    {"id": "t1", "text": "revisión del panel de administración"},
    {"id": "t2", "text": "csv export"},
    {"id": "t3", "text": "login"},
]


def test_a_spanish_ticket_ranks_first_for_an_english_question(api, tmp_path):
    source, embedder = resolve("auto", tmp_path, None, _env())
    ranking = rank(source, embedder, "admin page review", DOCS)
    assert ranking is not None
    assert [s["id"] for s in ranking.scores][0] == "t1"
    assert ranking.indexed == ranking.total == 3
    assert ranking.to_dict()["source"] == {
        "kind": "cloud",
        "provider": "openai",
        "model": "text-embedding-3-small",
    }
    url, payload, key = api.calls[0]
    assert url == "https://api.openai.com/v1/embeddings"
    assert payload["model"] == "text-embedding-3-small"
    assert key == "sk-test-0000"


def test_vectors_are_cached_so_the_next_question_sends_only_the_question(api, tmp_path):
    source, embedder = resolve("auto", tmp_path, None, _env())
    rank(source, embedder, "admin", DOCS)
    assert (tmp_path / semantic.CACHE_FILE).is_file()
    api.calls.clear()
    source, embedder = resolve("auto", tmp_path, None, _env())
    rank(source, embedder, "admin page review", DOCS)
    sent = [t for _, payload, _ in api.calls for t in payload["input"]]
    assert sent == ["admin page review"]


def test_secrets_in_a_ticket_are_masked_before_they_are_sent(
    api, tmp_path, monkeypatch
):
    source, embedder = resolve("auto", tmp_path, None, _env())
    leaked = "token ghp_" + "a" * 36  # pragma: allowlist secret
    rank(source, embedder, "admin", [{"id": "t", "text": leaked}])
    sent = json.dumps([payload for _, payload, _ in api.calls])
    assert "a" * 36 not in sent


@pytest.mark.parametrize(
    ("env", "why"),
    [
        (
            {"SELECTED_LLM_PROVIDER": "claude", "ANTHROPIC_API_KEY": "sk-test"},
            "no embeddings",
        ),
        ({"SELECTED_LLM_PROVIDER": "openai"}, "no key"),
        (
            {**_env(), "OPENAI_BASE_URL": "http://example.com/v1"},
            "plain http off the loopback",
        ),
        (
            {**_env(), "OPENAI_BASE_URL": "https://user:pw@example.com/v1"},
            "credentials in the URL",
        ),
    ],
)
def test_no_cloud_model_when_none_can_be_asked_safely(api, tmp_path, env, why):
    assert resolve("auto", tmp_path, None, env) is None, why


def test_local_mode_never_asks_the_provider(api, tmp_path):
    assert resolve("local", tmp_path, None, _env()) is None
    assert resolve("off", tmp_path, None, _env()) is None
    assert resolve("everything", tmp_path, None, _env()) is None
    assert api.calls == []


def test_the_strict_offline_policy_keeps_tickets_on_the_machine(api, tmp_path):
    project = tmp_path / "project"
    (project / ".workpilot").mkdir(parents=True)
    (project / ".workpilot" / "offline-mode.json").write_text(
        json.dumps({"airgapStrict": True}), encoding="utf-8"
    )
    assert resolve("auto", tmp_path, project, _env()) is None


def test_a_local_model_comes_first(monkeypatch, tmp_path):
    monkeypatch.setattr(
        semantic, "find", lambda: Found("ollama", "http://127.0.0.1:11434", "bge-m3")
    )
    found = resolve("local", tmp_path, None, _env())
    assert found is not None
    source, embedder = found
    assert source.to_dict() == {
        "kind": "local",
        "provider": "ollama",
        "model": "bge-m3",
    }
    assert isinstance(embedder, Embedder)
    assert embedder.budget > semantic.MAX_DOCUMENTS


@pytest.mark.parametrize(
    ("provider", "url"),
    [
        ("mistral", "https://api.mistral.ai/v1/embeddings"),
        (
            "gemini",
            "https://generativelanguage.googleapis.com/v1beta/openai/embeddings",
        ),
    ],
)
def test_other_providers_use_their_own_api(api, tmp_path, provider, url):
    cloud = CLOUDS[semantic._ALIASES.get(provider, provider)]
    env = {"SELECTED_LLM_PROVIDER": provider, cloud.key_env: "test-key"}
    source, embedder = resolve("auto", tmp_path, None, env)
    rank(source, embedder, "admin", DOCS)
    assert api.calls[0][0] == url


def test_an_openai_compatible_base_url_and_model_are_honoured(api, tmp_path):
    env = _env(
        OPENAI_BASE_URL="http://127.0.0.1:8080/v1/", BOARD_ASK_EMBEDDINGS_MODEL="bge-m3"
    )
    source, embedder = resolve("auto", tmp_path, None, env)
    rank(source, embedder, "admin", DOCS)
    assert api.calls[0][0] == "http://127.0.0.1:8080/v1/embeddings"
    assert source.model == "bge-m3"


def test_hugging_face_reads_e5_queries_and_passages_apart(monkeypatch, tmp_path):
    fake = FakeApi("huggingface")
    monkeypatch.setattr(semantic, "_post", fake)
    monkeypatch.setattr(semantic, "find", lambda: None)
    env = {"SELECTED_LLM_PROVIDER": "huggingface", "HUGGINGFACE_API_KEY": "hf_test"}
    source, embedder = resolve("auto", tmp_path, None, env)
    ranking = rank(source, embedder, "admin", DOCS)
    assert ranking is not None and ranking.scores[0]["id"] == "t1"
    url, first, _ = fake.calls[0]
    assert "intfloat/multilingual-e5-large" in url
    assert first["inputs"] == ["query: admin"]
    assert fake.calls[1][1]["inputs"][0].startswith("passage: ")


def test_a_failing_api_gives_no_ranking(api, tmp_path):
    api.fail = True
    source, embedder = resolve("auto", tmp_path, None, _env())
    assert rank(source, embedder, "admin", DOCS) is None


def test_an_answer_that_is_not_vectors_is_refused(monkeypatch, tmp_path):
    monkeypatch.setattr(semantic, "find", lambda: None)
    answers = iter(
        [{"data": [{"embedding": [1.0, 0.0], "index": 0}]}, {"data": "nope"}]
    )
    monkeypatch.setattr(semantic, "_post", lambda *a: next(answers))
    source, embedder = resolve("auto", tmp_path, None, _env())
    ranking = rank(source, embedder, "admin", DOCS)
    assert ranking is not None
    assert ranking.scores == [] and ranking.indexed == 0 and ranking.total == 3


def test_a_vector_with_a_non_number_is_dropped():
    assert semantic._vector([1.0, math.nan]) is None
    assert semantic._vector([True, 1.0]) is None
    assert semantic._vector([]) is None
    assert semantic._vector([1, 2.5]) == [1.0, 2.5]


def test_the_time_budget_leaves_unread_tickets_out(api, tmp_path, monkeypatch):
    monkeypatch.setattr(semantic, "LOCAL_CHUNK", 1)
    ticks = iter([0.0, 0.0, 0.0, 100.0, 100.0])
    source, embedder = resolve("auto", tmp_path, None, _env())
    ranking = rank(
        source, embedder, "admin", DOCS, budget_s=10, clock=lambda: next(ticks)
    )
    assert ranking is not None
    assert (ranking.indexed, ranking.total) == (2, 3)


def test_a_redirect_is_not_followed():
    with pytest.raises(ValueError):
        semantic._NoRedirect().redirect_request(
            None, None, 302, "Found", {}, "https://elsewhere"
        )


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("https://api.example.com/v1/", "https://api.example.com/v1"),
        ("http://localhost:1234/v1", "http://localhost:1234/v1"),
        ("http://[::1]:1234/v1", "http://[::1]:1234/v1"),
        ("http://10.0.0.2/v1", None),
        ("https://api.example.com/v1?x=1", None),
        ("https://api.example.com:99999/v1", None),
        ("ftp://api.example.com", None),
        ("", None),
    ],
)
def test_endpoint_base(raw, expected):
    assert endpoint_base(raw) == expected


def test_the_cache_keeps_only_well_formed_entries(tmp_path):
    (tmp_path / semantic.CACHE_FILE).write_text(
        json.dumps({"vectors": {"a": "not base64!", "b": 3}}), encoding="utf-8"
    )
    embedder = CloudEmbedder(
        tmp_path, "openai", CLOUDS["openai"], "k", "https://x/v1", "m"
    )
    assert set(embedder._cache) == {"a"}
    assert semantic._unpack("not base64!") is None
    (tmp_path / semantic.CACHE_FILE).write_text("[]", encoding="utf-8")
    assert (
        CloudEmbedder(
            tmp_path, "openai", CLOUDS["openai"], "k", "https://x/v1", "m"
        )._cache
        == {}
    )


def test_a_cache_that_cannot_be_written_is_not_an_error(api, tmp_path):
    blocked = tmp_path / "file"
    blocked.write_text("", encoding="utf-8")
    source, embedder = resolve("auto", blocked / "sub", None, _env())
    assert rank(source, embedder, "admin", DOCS) is not None


class TestParseRequest:
    def _raw(self, tmp_path: Path, **extra):
        return {
            "mode": "auto",
            "cache_dir": str(tmp_path),
            "project_dir": str(tmp_path),
            "query": " admin ",
            "documents": [{"id": "t1", "text": "x" * 5000}],
            **extra,
        }

    def test_a_valid_request(self, tmp_path):
        request = parse_request(self._raw(tmp_path))
        assert request["queries"] == ["admin"] and request["many"] is False
        assert len(request["documents"][0]["text"]) == semantic.MAX_TEXT_CHARS

    @pytest.mark.parametrize(
        "extra",
        [
            {"mode": "cloud"},
            {"cache_dir": "relative/dir"},
            {"project_dir": "relative"},
            {"query": "  "},
            {"documents": "t1"},
            {"documents": [{"id": "", "text": "x"}]},
            {"documents": [{"id": "t", "text": 3}]},
            {"documents": ["t"]},
            {"documents": [{"id": "t", "text": "x"}] * (semantic.MAX_DOCUMENTS + 1)},
        ],
    )
    def test_refusals(self, tmp_path, extra):
        with pytest.raises(ValueError):
            parse_request(self._raw(tmp_path, **extra))

    def test_several_queries(self, tmp_path):
        raw = self._raw(tmp_path)
        del raw["query"]
        request = parse_request({**raw, "queries": [" a ", "b"]})
        assert request["queries"] == ["a", "b"] and request["many"] is True

    @pytest.mark.parametrize(
        "queries", [[], "a", ["a", " "], ["a"] * (semantic.MAX_QUERIES + 1)]
    )
    def test_bad_queries(self, tmp_path, queries):
        with pytest.raises(ValueError):
            parse_request({**self._raw(tmp_path), "queries": queries})

    def test_not_an_object(self):
        with pytest.raises(ValueError):
            parse_request([])


def test_source_to_dict():
    assert Source("local", "ollama", "bge-m3").to_dict()["kind"] == "local"


def test_unpack_refuses_what_is_not_a_float_array():
    assert semantic._unpack("") is None
    assert semantic._unpack("AAAA") is None  # three bytes
    assert semantic._unpack(3) is None


@pytest.mark.parametrize(
    "answer",
    [[], {"data": "x"}, {"data": [1]}, {"data": [{"embedding": [1.0], "index": 0}]}],
)
def test_an_openai_answer_of_the_wrong_shape_is_refused(answer):
    with pytest.raises(ValueError):
        semantic._openai_vectors(answer, 2)


def test_an_openai_answer_without_indexes_keeps_its_order():
    answer = {"data": [{"embedding": [1.0]}, {"embedding": [2.0]}]}
    assert semantic._openai_vectors(answer, 2) == [[1.0], [2.0]]


@pytest.mark.parametrize("answer", [{}, [[1.0]]])
def test_a_hugging_face_answer_of_the_wrong_size_is_refused(answer):
    with pytest.raises(ValueError):
        semantic._hf_vectors(answer, 2)


def test_once_down_an_embedder_asks_nothing_more(api, tmp_path):
    _, embedder = resolve("auto", tmp_path, None, _env())
    embedder.down = True
    assert embedder.vectors(["admin"]) == [None]
    assert api.calls == []


def test_a_bad_vector_in_a_batch_leaves_only_that_ticket_out(monkeypatch, tmp_path):
    monkeypatch.setattr(semantic, "find", lambda: None)

    def post(url, payload, key, timeout):
        texts = payload["input"]
        return {
            "data": [
                {"embedding": ["x"] if t == "csv export" else _vector_of(t), "index": i}
                for i, t in enumerate(texts)
            ]
        }

    monkeypatch.setattr(semantic, "_post", post)
    source, embedder = resolve("auto", tmp_path, None, _env())
    ranking = rank(source, embedder, "admin", DOCS)
    assert ranking is not None
    assert {s["id"] for s in ranking.scores} == {"t1", "t3"}


def test_nothing_new_writes_no_cache(tmp_path):
    embedder = CloudEmbedder(
        tmp_path, "openai", CLOUDS["openai"], "k", "https://x/v1", "m"
    )
    embedder.save()
    assert not (tmp_path / semantic.CACHE_FILE).exists()


class _Api:
    """A loopback embeddings API for `_post` itself."""

    def __init__(self, status=200, body=b"{}", location=None):
        import http.server
        import threading

        outer = self
        self.seen: list[dict] = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers.get("Content-Length", 0))
                outer.seen.append(
                    {
                        "auth": self.headers.get("Authorization"),
                        "body": json.loads(self.rfile.read(length)),
                    }
                )
                self.send_response(status)
                if location:
                    self.send_header("Location", location)
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        self.server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_port}/v1/embeddings"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def test_post_sends_the_key_in_the_header_and_reads_json():
    api = _Api(body=b'{"data": []}')
    try:
        assert semantic._post(api.url, {"input": ["a"]}, "sk-test-0000", 5) == {
            "data": []
        }
    finally:
        api.close()
    assert api.seen == [{"auth": "Bearer sk-test-0000", "body": {"input": ["a"]}}]


def test_post_refuses_an_answer_too_large(monkeypatch):
    monkeypatch.setattr(semantic, "MAX_RESPONSE", 4)
    api = _Api(body=b'{"data": []}')
    try:
        with pytest.raises(ValueError):
            semantic._post(api.url, {}, "k", 5)
    finally:
        api.close()


def test_post_does_not_follow_a_redirect():
    api = _Api(status=307, location="http://127.0.0.1:9/elsewhere")
    try:
        with pytest.raises(ValueError):
            semantic._post(api.url, {}, "k", 5)
    finally:
        api.close()


def test_several_queries_share_one_reading_of_the_tickets(api, tmp_path):
    source, embedder = resolve("auto", tmp_path, None, _env())
    rankings = semantic.rank_many(source, embedder, ["admin", "csv export"], DOCS)
    assert rankings is not None
    assert [r.scores[0]["id"] for r in rankings] == ["t1", "t2"]
    sent = [t for _, payload, _ in api.calls for t in payload["input"]]
    # Each text once: a query that is also a ticket's text is not sent twice.
    assert sorted(sent) == sorted({"admin", *(d["text"] for d in DOCS)})


def test_a_query_without_a_vector_gets_no_ranking(monkeypatch, tmp_path):
    monkeypatch.setattr(semantic, "find", lambda: None)

    def post(url, payload, key, timeout):
        return {
            "data": [
                {"embedding": ["x"] if t == "bad" else _vector_of(t), "index": i}
                for i, t in enumerate(payload["input"])
            ]
        }

    monkeypatch.setattr(semantic, "_post", post)
    source, embedder = resolve("auto", tmp_path, None, _env())
    rankings = semantic.rank_many(source, embedder, ["bad", "admin"], DOCS)
    assert rankings is not None and rankings[0] is None and rankings[1] is not None

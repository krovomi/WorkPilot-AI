"""Spotting duplicate GitHub issues by meaning, not by shared words.

`DuplicateDetector` (runners/github/duplicates.py) embeds each issue's title
and body, caches the embeddings per repository with a time to live, and
compares issues by cosine similarity, with the error codes, file paths,
function names and URLs they share as a breakdown. Its threshold also sets
how close two issues must be for issue batching (`SIMILAR_THRESHOLD`).

What stands in: the embedding services. OpenAI's SDK and sentence-transformers
are replaced by small modules in `sys.modules`; Voyage AI's HTTP API by an
`httpx.MockTransport`. The cache files are real, in tmp_path.
"""

from __future__ import annotations

import asyncio
import json
import sys
from datetime import UTC, datetime, timedelta
from types import ModuleType, SimpleNamespace

import httpx
import pytest
from runners.github.duplicates import (
    DUPLICATE_THRESHOLD,
    SIMILAR_THRESHOLD,
    CachedEmbedding,
    DuplicateDetector,
    EmbeddingProvider,
    EntityExtraction,
    EntityExtractor,
    SimilarityResult,
)

WORDS = ("login", "safari", "crash", "timeout", "export")


def embed(text: str) -> list[float]:
    """A tiny, deterministic embedding: how often each word appears."""
    lowered = text.lower()
    return [float(lowered.count(word)) for word in WORDS]


class _Vector(list):
    def tolist(self):
        return list(self)


@pytest.fixture
def local_model(monkeypatch):
    """sentence-transformers, answering with `embed`; counts what it embeds."""
    seen: list[str] = []
    module = ModuleType("sentence_transformers")

    class SentenceTransformer:
        def __init__(self, name):
            self.name = name

        def encode(self, text):
            if "unembeddable" in text:
                raise ValueError("cannot embed")
            seen.append(text)
            return _Vector(embed(text))

    module.SentenceTransformer = SentenceTransformer
    monkeypatch.setitem(sys.modules, "sentence_transformers", module)
    return seen


@pytest.fixture
def detector(tmp_path, local_model):
    return DuplicateDetector(
        cache_dir=tmp_path / "embeddings", embedding_provider="local"
    )


def issue(number, title, body=""):
    return {"number": number, "title": title, "body": body}


# ---------------------------------------------------------------------------
# What an issue mentions
# ---------------------------------------------------------------------------


def test_the_entities_an_issue_mentions_are_extracted():
    text = (
        "Login fails with ERR-1234 and AUTH_5001 (Error: TOKEN_EXPIRED) in "
        "`src/auth/login.py` and a.b see https://example.com/issues/1).\n"
        "Calls refresh_token( then def handle_login and async function go_now, "
        "ab( is too short. Since v2.3.1-beta and 1.4.\n"
        'File "src/auth/login.py", line 42\n'
        "at Object.run (app.js:10)\nat main (index.js:2)\n"
    )

    found = EntityExtractor().extract(text)

    assert sorted(found.error_codes) == [
        "AUTH_5001",
        "ERR-1234",
        "Error: TOKEN_EXPIRED",
    ]
    assert "src/auth/login.py" in found.file_paths
    assert "a.b" not in found.file_paths
    assert {"refresh_token", "handle_login", "go_now"} <= set(found.function_names)
    assert "ab" not in found.function_names
    assert found.urls == ["https://example.com/issues/1"]
    assert {"v2.3.1-beta", "1.4"} <= set(found.versions)
    assert found.stack_traces[0] == 'File "src/auth/login.py", line 42'
    assert found.to_dict()["urls"] == found.urls


def test_shared_entities_are_scored_by_overlap():
    a = EntityExtraction(error_codes=["E1001", "E1002"], file_paths=["x.py"])
    b = EntityExtraction(error_codes=["E1001"], urls=["https://u"])

    assert a.overlap_with(b) == {
        "error_codes": 0.5,
        "file_paths": 0.0,
        "urls": 0.0,
        "function_names": 0.0,
    }


# ---------------------------------------------------------------------------
# Embedding services
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("provider", "model"),
    [
        ("openai", "text-embedding-3-small"),
        ("voyage", "voyage-large-2"),
        ("huggingface", "thenlper/gte-large"),
        ("local", "all-MiniLM-L6-v2"),
        ("unknown", "text-embedding-3-small"),
    ],
)
def test_each_service_has_a_default_model(provider, model):
    assert EmbeddingProvider(provider=provider).model == model
    assert EmbeddingProvider(provider=provider, model="chosen").model == "chosen"


def test_openai_embeds_the_first_8000_characters_with_the_given_key(monkeypatch):
    requests = []
    module = ModuleType("openai")

    class AsyncOpenAI:
        def __init__(self, api_key):
            self.embeddings = SimpleNamespace(create=self.create)
            self.api_key = api_key

        async def create(self, model, input):
            requests.append((self.api_key, model, input))
            return SimpleNamespace(data=[SimpleNamespace(embedding=[0.1, 0.2])])

    module.AsyncOpenAI = AsyncOpenAI
    monkeypatch.setitem(sys.modules, "openai", module)
    provider = EmbeddingProvider(api_key="sk-test-0000")  # pragma: allowlist secret

    assert asyncio.run(provider.get_embedding("x" * 9000)) == [0.1, 0.2]
    assert requests == [
        ("sk-test-0000", "text-embedding-3-small", "x" * 8000)
    ]  # pragma: allowlist secret


def test_openai_without_its_sdk_says_how_to_fix_it(monkeypatch):
    monkeypatch.setitem(sys.modules, "openai", None)

    with pytest.raises(Exception, match="Configure OPENAI_API_KEY or use 'local'"):
        asyncio.run(EmbeddingProvider("openai").get_embedding("text"))


def _voyage(monkeypatch, reply):
    sent = []

    def handler(request):
        sent.append(request)
        return httpx.Response(200, json=reply)

    real = httpx.AsyncClient
    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda **kw: real(transport=httpx.MockTransport(handler), **kw),
    )
    return sent


def test_voyage_embeds_through_its_api_with_the_key_as_bearer(monkeypatch):
    sent = _voyage(monkeypatch, {"data": [{"embedding": [1.0, 0.0]}]})
    provider = EmbeddingProvider(
        "voyage", api_key="pa-test-0000"
    )  # pragma: allowlist secret

    assert asyncio.run(provider.get_embedding("y" * 9000)) == [1.0, 0.0]
    [request] = sent
    assert str(request.url) == "https://api.voyageai.com/v1/embeddings"
    assert (
        request.headers["Authorization"] == "Bearer pa-test-0000"
    )  # pragma: allowlist secret
    assert json.loads(request.content) == {
        "model": "voyage-large-2",
        "input": "y" * 8000,
    }


def test_a_voyage_error_says_how_to_fix_it(monkeypatch):
    _voyage(monkeypatch, {"detail": "invalid key"})

    with pytest.raises(Exception, match="Configure VOYAGE_API_KEY or use 'local'"):
        asyncio.run(EmbeddingProvider("voyage").get_embedding("text"))


def _hugging_face(monkeypatch, *replies):
    """Hugging Face's router, answering with `replies` in turn."""
    sent = []
    queue = list(replies)

    def handler(request):
        sent.append(request)
        status, body = queue.pop(0)
        return httpx.Response(status, json=body)

    real = httpx.AsyncClient
    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda **kw: real(transport=httpx.MockTransport(handler), **kw),
    )
    return sent


def test_hugging_face_embeds_on_the_router_s_feature_extraction(monkeypatch):
    sent = _hugging_face(monkeypatch, (200, [0.5, 0.25]))
    provider = EmbeddingProvider(
        "huggingface", api_key="hf_test_0000"
    )  # pragma: allowlist secret

    assert asyncio.run(provider.get_embedding("z" * 9000)) == [0.5, 0.25]
    [request] = sent
    assert str(request.url) == (
        "https://router.huggingface.co/hf-inference/models/thenlper/gte-large"
        "/pipeline/feature-extraction"
    )
    assert (
        request.headers["Authorization"] == "Bearer hf_test_0000"
    )  # pragma: allowlist secret
    assert json.loads(request.content) == {
        "inputs": "z" * 8000,
        "normalize": True,
        "truncate": True,
    }


def test_a_loading_hugging_face_model_is_asked_again_and_waited_for(monkeypatch):
    sent = _hugging_face(monkeypatch, (503, {"error": "loading"}), (200, [[1, 0.5]]))

    vector = asyncio.run(EmbeddingProvider("huggingface").get_embedding("text"))

    assert vector == [1.0, 0.5]
    assert [r.headers.get("x-wait-for-model") for r in sent] == [None, "true"]
    assert "Authorization" not in sent[0].headers


def test_a_hugging_face_refusal_is_an_http_error(monkeypatch):
    _hugging_face(monkeypatch, (401, {"error": "bad token"}))

    with pytest.raises(httpx.HTTPStatusError):
        asyncio.run(EmbeddingProvider("huggingface").get_embedding("text"))


@pytest.mark.parametrize(
    "reply", [[], [[]], {"error": "x"}, ["a", "b"], [True, False], [[[0.1]]]]
)
def test_a_hugging_face_answer_without_a_vector_is_refused(monkeypatch, reply):
    _hugging_face(monkeypatch, (200, reply))

    with pytest.raises(ValueError, match="no embedding vector"):
        asyncio.run(EmbeddingProvider("huggingface").get_embedding("text"))


@pytest.mark.parametrize(
    "model", ["gte-large", "../../api/whoami", "a/b/c", "a/b?x=1", "/b", "a/.."]
)
def test_only_a_hub_repo_id_reaches_the_hugging_face_url(monkeypatch, model):
    sent = _hugging_face(monkeypatch, (200, [0.1]))

    with pytest.raises(ValueError, match="Not a Hugging Face model id"):
        asyncio.run(EmbeddingProvider("huggingface", model=model).get_embedding("x"))
    assert sent == []


def test_the_local_model_without_its_package_says_how_to_install_it(monkeypatch):
    monkeypatch.setitem(sys.modules, "sentence_transformers", None)

    with pytest.raises(Exception, match="pip install sentence-transformers"):
        asyncio.run(EmbeddingProvider("local").get_embedding("text"))


# ---------------------------------------------------------------------------
# Comparing issues
# ---------------------------------------------------------------------------


def test_two_reports_of_the_same_bug_are_duplicates(detector):
    a = issue(1, "Login crash on Safari", "Login crash with ERR-1001 in auth.py")
    b = issue(2, "Safari login crash", "Crash at login, ERR-1001 again in auth.py")

    result = asyncio.run(detector.compare_issues("own/repo", a, b))

    assert result.is_duplicate and result.is_similar
    assert result.overall_score >= DUPLICATE_THRESHOLD
    assert result.title_score > 0.9 and result.body_score > 0.9
    assert result.entity_scores["error_codes"] == 1.0
    assert result.explanation.startswith("High semantic similarity (")
    assert "Error Codes: 100%" in result.explanation
    assert "Urls" not in result.explanation
    assert result.to_dict()["issue_b"] == 2


def test_unrelated_issues_are_neither_duplicate_nor_similar(detector):
    a = issue(1, "Login crash")
    b = issue(2, "Export timeout")

    result = asyncio.run(detector.compare_issues("own/repo", a, b))

    assert not result.is_similar and not result.is_duplicate
    assert result.body_score == 0.0
    assert result.explanation.startswith("Moderate similarity (0%)")


def test_the_closest_issues_come_first_without_the_issue_itself(detector):
    open_issues = [
        issue(1, "Login crash on Safari"),
        issue(2, "Safari login crash"),
        issue(3, "Login crash"),
        issue(4, "Export timeout"),
        {"title": "no number"},
    ]

    found = asyncio.run(
        detector.find_duplicates(
            "own/repo", 1, "Login crash on Safari", "", open_issues
        )
    )
    capped = asyncio.run(
        detector.find_duplicates(
            "own/repo", 1, "Login crash on Safari", "", open_issues, limit=1
        )
    )

    assert [r.issue_b for r in found] == [2, 3]
    assert found[0].overall_score >= found[1].overall_score >= SIMILAR_THRESHOLD
    assert [r.issue_b for r in capped] == [2]


def test_embeddings_of_different_sizes_or_empty_ones_are_not_similar(detector):
    assert detector.cosine_similarity([1.0, 0.0], [1.0]) == 0.0
    assert detector.cosine_similarity([0.0, 0.0], [1.0, 0.0]) == 0.0
    assert detector.cosine_similarity([1.0, 1.0], [2.0, 2.0]) == pytest.approx(1.0)


# ---------------------------------------------------------------------------
# The embedding cache
# ---------------------------------------------------------------------------


def test_an_issue_is_embedded_once_until_its_text_changes(detector, local_model):
    first = asyncio.run(detector.get_embedding("own/repo", 1, "Login crash", "x"))
    again = asyncio.run(detector.get_embedding("own/repo", 1, "Login crash", "x"))
    edited = asyncio.run(detector.get_embedding("own/repo", 1, "Login crash", "y"))

    assert first == again == edited
    assert local_model == ["Login crash\n\nx", "Login crash\n\ny"]
    cache = json.loads(
        (detector.cache_dir / "own_repo_embeddings.json").read_text(encoding="utf-8")
    )
    [entry] = cache["embeddings"]
    assert entry["issue_number"] == 1 and entry["embedding"] == first


def test_expired_embeddings_are_computed_again(tmp_path, local_model):
    detector = DuplicateDetector(
        cache_dir=tmp_path / "embeddings",
        embedding_provider="local",
        cache_ttl_hours=-1,
    )

    asyncio.run(detector.get_embedding("own/repo", 1, "Login", ""))
    asyncio.run(detector.get_embedding("own/repo", 1, "Login", ""))

    assert len(local_model) == 2


def test_a_cached_embedding_knows_when_it_expires():
    now = datetime.now(UTC)
    entry = CachedEmbedding(
        issue_number=1,
        content_hash="h",
        embedding=[1.0],
        created_at=now.isoformat(),
        expires_at=(now + timedelta(hours=1)).isoformat(),
    )

    assert not entry.is_expired()
    assert CachedEmbedding.from_dict(entry.to_dict()) == entry


def test_precomputing_counts_the_issues_embedded_and_skips_the_broken_ones(
    detector,
):
    count = asyncio.run(
        detector.precompute_embeddings(
            "own/repo",
            [issue(1, "Login"), issue(2, "Export"), issue(3, "unembeddable")],
        )
    )

    assert count == 2


def test_clearing_the_cache_forgets_the_repository(detector):
    asyncio.run(detector.get_embedding("own/repo", 1, "Login", ""))

    detector.clear_cache("own/repo")
    detector.clear_cache("own/repo")

    assert not (detector.cache_dir / "own_repo_embeddings.json").exists()


def test_a_similarity_result_round_trips_to_a_dict():
    result = SimilarityResult(1, 2, 0.9, 0.8, 0.7, {}, True, True, "x")

    assert result.to_dict() == {
        "issue_a": 1,
        "issue_b": 2,
        "overall_score": 0.9,
        "title_score": 0.8,
        "body_score": 0.7,
        "entity_scores": {},
        "is_duplicate": True,
        "is_similar": True,
        "explanation": "x",
    }

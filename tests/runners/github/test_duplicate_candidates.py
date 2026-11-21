"""Which open issues the triage shows the model as possible duplicates.

`potential_duplicates` (runners/github/services/duplicate_candidates.py)
compares issues by meaning when an embedding service is set (Hugging Face,
OpenAI, Voyage or a local model) and by shared title words otherwise, or when
the service fails. The services are stand-ins: a fake `sentence_transformers`
module and `httpx.MockTransport`. Keys are fake values.
"""

from __future__ import annotations

import asyncio
import json
import sys
from types import ModuleType

import httpx
import pytest
from runners.github.services import duplicate_candidates as dc

WORDS = ("login", "safari", "crash", "timeout", "export")
KEYS = (
    "ISSUE_EMBEDDINGS_PROVIDER",
    "ISSUE_EMBEDDINGS_MODEL",
    "HUGGINGFACE_API_KEY",
    "HF_TOKEN",
    "OPENAI_API_KEY",
    "VOYAGE_API_KEY",
)


@pytest.fixture(autouse=True)
def no_keys(monkeypatch):
    for name in KEYS:
        monkeypatch.delenv(name, raising=False)


@pytest.fixture
def local_model(monkeypatch):
    """sentence-transformers, counting word occurrences; records its texts."""
    seen: list[str] = []
    module = ModuleType("sentence_transformers")

    class _Vector(list):
        def tolist(self):
            return list(self)

    class SentenceTransformer:
        def __init__(self, name):
            self.name = name

        def encode(self, text):
            seen.append(text)
            lowered = text.lower()
            return _Vector(float(lowered.count(word)) for word in WORDS)

    module.SentenceTransformer = SentenceTransformer
    monkeypatch.setitem(sys.modules, "sentence_transformers", module)
    return seen


def issue(number, title, body=""):
    return {"number": number, "title": title, "body": body}


def strict_offline(tmp_path):
    (tmp_path / ".workpilot").mkdir()
    (tmp_path / ".workpilot" / "offline-mode.json").write_text(
        json.dumps({"airgapStrict": True}), encoding="utf-8"
    )
    return tmp_path


def test_without_any_key_issues_are_compared_by_shared_words():
    assert dc.embedding_provider() is None


@pytest.mark.parametrize(
    ("keys", "chosen"),
    [
        ({"HF_TOKEN": "hf_test_0000"}, "huggingface"),
        ({"HUGGINGFACE_API_KEY": "hf_test_0000"}, "huggingface"),
        ({"OPENAI_API_KEY": "sk-test-0000"}, "openai"),
        ({"VOYAGE_API_KEY": "pa-test-0000"}, "voyage"),
        (
            {"OPENAI_API_KEY": "sk-test-0000", "HF_TOKEN": "hf_test_0000"},
            "huggingface",
        ),
    ],
)
def test_the_first_service_with_a_key_is_used(monkeypatch, keys, chosen):
    for name, value in keys.items():
        monkeypatch.setenv(name, value)

    assert dc.embedding_provider() == chosen


@pytest.mark.parametrize("words", ["none", "off", "Words"])
def test_shared_words_can_be_asked_for_even_with_a_key(monkeypatch, words):
    monkeypatch.setenv("HF_TOKEN", "hf_test_0000")
    monkeypatch.setenv("ISSUE_EMBEDDINGS_PROVIDER", words)

    assert dc.embedding_provider() is None


def test_a_named_service_is_used_only_with_its_key(monkeypatch):
    monkeypatch.setenv("HF_TOKEN", "hf_test_0000")
    monkeypatch.setenv("ISSUE_EMBEDDINGS_PROVIDER", "voyage")
    assert dc.embedding_provider() is None

    monkeypatch.setenv("VOYAGE_API_KEY", "pa-test-0000")
    assert dc.embedding_provider() == "voyage"

    monkeypatch.setenv("ISSUE_EMBEDDINGS_PROVIDER", "local")
    assert dc.embedding_provider() == "local"


def test_a_strict_offline_project_only_embeds_locally(monkeypatch, tmp_path):
    project = strict_offline(tmp_path)
    monkeypatch.setenv("HF_TOKEN", "hf_test_0000")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-0000")
    assert dc.embedding_provider(project) is None

    monkeypatch.setenv("ISSUE_EMBEDDINGS_PROVIDER", "huggingface")
    assert dc.embedding_provider(project) is None

    monkeypatch.setenv("ISSUE_EMBEDDINGS_PROVIDER", "local")
    assert dc.embedding_provider(project) == "local"
    assert dc.embedding_provider(None) == "local"


def candidates(issue_, others, tmp_path, project=None):
    return asyncio.run(
        dc.potential_duplicates(
            issue_,
            [issue_, *others],
            repo="own/repo",
            cache_dir=tmp_path / "embeddings",
            project_dir=project,
        )
    )


def test_shared_words_keep_at_most_five_and_never_the_issue_itself(tmp_path):
    crash = issue(1, "Crash on export")
    alikes = [issue(n, f"Crash on export {n}") for n in range(2, 9)]

    found = candidates(crash, [*alikes, issue(9, "Dark mode")], tmp_path)

    assert [o["number"] for o in found] == [2, 3, 4, 5, 6]
    assert all("similarity" not in o for o in found)


def test_with_a_model_the_closest_in_meaning_come_first(
    monkeypatch, tmp_path, local_model
):
    monkeypatch.setenv("ISSUE_EMBEDDINGS_PROVIDER", "local")
    login = issue(1, "Login broken", "Safari login timeout")
    others = [
        issue(2, "Cannot sign in", "login fails on safari, timeout"),
        issue(3, "Export is slow", "export export crash"),
        issue(4, "Sign in on Safari", "login fails on safari"),
    ]

    found = candidates(login, others, tmp_path)

    assert [o["number"] for o in found] == [2, 4]
    assert found[0]["similarity"] >= found[1]["similarity"] >= 0.7
    assert found[0]["title"] == "Cannot sign in"
    # One cache per service and model.
    assert (tmp_path / "embeddings" / "local-all-MiniLM-L6-v2").is_dir()


def test_only_the_most_recent_open_issues_are_embedded(
    monkeypatch, tmp_path, local_model
):
    monkeypatch.setenv("ISSUE_EMBEDDINGS_PROVIDER", "local")
    monkeypatch.setattr(dc, "MAX_COMPARED", 2)
    others = [issue(n, f"Issue {n}", f"body {n}") for n in range(2, 7)]

    candidates(issue(1, "Issue 1", "body 1"), others, tmp_path)

    assert len(local_model) == 3


def test_a_hugging_face_failure_falls_back_to_shared_words(
    monkeypatch, tmp_path, caplog
):
    monkeypatch.setenv("HF_TOKEN", "hf_test_0000")
    sent = []

    def handler(request):
        sent.append(request)
        return httpx.Response(401, json={"error": "bad token"})

    real = httpx.AsyncClient
    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda **kw: real(transport=httpx.MockTransport(handler), **kw),
    )
    crash = issue(1, "Crash on export")

    found = candidates(crash, [issue(2, "Crash on export again")], tmp_path)

    assert [o["number"] for o in found] == [2]
    assert "similarity" not in found[0]
    assert sent and sent[0].url.host == "router.huggingface.co"
    assert "Issue embeddings unavailable (huggingface): HTTPStatusError" in (
        caplog.text
    )
    assert "hf_test_0000" not in caplog.text


def test_a_chosen_model_has_a_cache_of_its_own(monkeypatch, tmp_path, local_model):
    monkeypatch.setenv("ISSUE_EMBEDDINGS_PROVIDER", "local")
    monkeypatch.setenv("ISSUE_EMBEDDINGS_MODEL", "org/other-model")

    candidates(issue(1, "Crash"), [issue(2, "Crash again")], tmp_path)

    assert (tmp_path / "embeddings" / "local-org_other-model").is_dir()

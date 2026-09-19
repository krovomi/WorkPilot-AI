"""What the editor endpoints hand back — and what they must never hand back.

CodeQL raised `py/stack-trace-exposure` against the first version of these
handlers, which returned `str(e)`. It was right twice over: an exception's own
text on a response path is the pattern, and two of those messages really did
carry a resolved filesystem path. The refusal is rendered from `_REASONS` now,
a literal table filled only from values the caller sent. These pin that.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from i18n_scaler.api import _REASONS, _editor_error, router
from i18n_scaler.editor import EditorError


@pytest.fixture
def client() -> TestClient:
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


@pytest.fixture
def locales(tmp_path: Path) -> Path:
    root = tmp_path / "locales"
    for locale, data in (
        ("en", {"buttons": {"save": "Save"}}),
        ("fr", {"buttons": {"save": "Enregistrer"}}),
    ):
        d = root / locale
        d.mkdir(parents=True)
        (d / "common.json").write_text(
            json.dumps(data, indent="\t", ensure_ascii=False) + "\n", encoding="utf-8"
        )
    return root


class TestReasonTable:
    def test_every_reason_renders_from_its_own_params(self):
        """A template asking for a value its raiser never sets would read
        "Invalid input" in production and nowhere else."""
        params = {
            "file": "common.json",
            "namespace": "common",
            "key": "a.b",
            "other": "a",
            "locale": "de",
        }
        for reason, template in _REASONS.items():
            rendered = template.format(**params)
            assert rendered, reason
            assert "{" not in rendered, reason

    def test_an_unmapped_reason_falls_back_rather_than_leaking(self):
        leak = "/srv/tenant-42/checkout/locales"
        assert _editor_error(EditorError("brand-new", leak), "op") == "Invalid input"

    def test_a_refusal_never_returns_the_exception_text(self):
        # The message carries the path for the log; the caller gets the table's.
        e = EditorError(
            "no-namespace", "No namespace 'x' under /srv/secret.", namespace="x"
        )
        rendered = _editor_error(e, "namespace")
        assert "/srv/secret" not in rendered
        assert "x" in rendered


class TestEndpointRefusals:
    def test_a_missing_namespace_names_it_and_no_path(self, client, locales):
        r = client.post(
            "/api/i18n-scaler/namespace",
            json={"locales_dir": str(locales), "namespace": "nope"},
        ).json()
        assert r["success"] is False
        assert "nope" in r["error"]
        assert str(locales) not in r["error"]

    def test_a_bad_key_is_named_without_a_traceback(self, client, locales):
        r = client.post(
            "/api/i18n-scaler/mutate",
            json={
                "locales_dir": str(locales),
                "namespace": "common",
                "operations": [{"op": "add", "key": "a..b", "values": {"en": "x"}}],
                "fingerprints": {},
            },
        ).json()
        assert r["success"] is False
        assert "a..b" in r["error"]
        assert "Traceback" not in r["error"]
        assert str(locales) not in r["error"]

    def test_an_unknown_locale_is_named(self, client, locales):
        r = client.post(
            "/api/i18n-scaler/mutate",
            json={
                "locales_dir": str(locales),
                "namespace": "common",
                "operations": [
                    {"op": "set", "key": "buttons.save", "values": {"de": "x"}}
                ],
                "fingerprints": {},
            },
        ).json()
        assert r["success"] is False
        assert "de" in r["error"]

    def test_a_stale_save_is_flagged_and_names_the_file(self, client, locales):
        view = client.post(
            "/api/i18n-scaler/namespace",
            json={"locales_dir": str(locales), "namespace": "common"},
        ).json()["view"]
        ops = [{"op": "set", "key": "buttons.save", "values": {"fr": "Sauver"}}]
        body = {
            "locales_dir": str(locales),
            "namespace": "common",
            "operations": ops,
            "fingerprints": view["fingerprints"],
        }
        assert client.post("/api/i18n-scaler/mutate", json=body).json()["success"]

        again = client.post("/api/i18n-scaler/mutate", json=body).json()
        assert again["success"] is False
        assert again["stale"] is True
        assert "common.json" in again["error"]
        assert str(locales) not in again["error"]

    def test_an_unknown_operation_is_refused_by_name(self, client, locales):
        r = client.post(
            "/api/i18n-scaler/mutate",
            json={
                "locales_dir": str(locales),
                "namespace": "common",
                "operations": [{"op": "explode", "key": "a", "values": {}}],
                "fingerprints": {},
            },
        ).json()
        assert r["success"] is False
        assert "explode" in r["error"]


class TestHappyPath:
    def test_namespaces_then_namespace_then_mutate(self, client, locales):
        listed = client.post(
            "/api/i18n-scaler/namespaces", json={"locales_dir": str(locales)}
        ).json()
        assert listed["success"] and listed["locales"] == ["en", "fr"]
        assert [n["namespace"] for n in listed["namespaces"]] == ["common"]

        view = client.post(
            "/api/i18n-scaler/namespace",
            json={"locales_dir": str(locales), "namespace": "common"},
        ).json()["view"]
        assert [e["key"] for e in view["entries"]] == ["buttons.save"]

        saved = client.post(
            "/api/i18n-scaler/mutate",
            json={
                "locales_dir": str(locales),
                "namespace": "common",
                "operations": [
                    {"op": "add", "key": "buttons.undo", "values": {"en": "Undo"}}
                ],
                "fingerprints": view["fingerprints"],
            },
        ).json()
        assert saved["success"]
        assert [Path(p).parent.name for p in saved["written"]] == ["en"]

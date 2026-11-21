"""The i18n Auto-Scaler panel's routes: diff, skeleton, report, and the editor's edges.

`test_editor_api.py` pins what a refusal may say; this file walks the rest of
each route on real locale folders.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture
def client() -> TestClient:
    from i18n_scaler.api import router

    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def _locale(root: Path, locale: str, data: dict, name: str = "common.json") -> None:
    folder = root / locale
    folder.mkdir(parents=True, exist_ok=True)
    (folder / name).write_text(json.dumps(data), encoding="utf-8")


@pytest.fixture
def locales(tmp_path: Path) -> Path:
    root = tmp_path / "app" / "locales"
    _locale(root, "en", {"save": "Save", "undo": "Undo"})
    _locale(root, "fr", {"save": "Enregistrer"})
    return root


def _post(client: TestClient, route: str, body: dict) -> dict:
    return client.post(f"/api/i18n-scaler/{route}", json=body).json()


def test_a_diff_names_what_the_target_lacks(client) -> None:
    answer = _post(
        client,
        "diff",
        {"source": {"a": "A", "b": "B"}, "target": {"a": "Á", "c": "C"}},
    )

    assert answer["success"] is True
    diff = answer["diff"]
    assert diff["missing_keys"] == ["b"]
    assert diff["obsolete_keys"] == ["c"]


@pytest.mark.parametrize(
    ("strategy", "expected"),
    [(None, "[FR] Undo"), ("EMPTY", ""), ("source_value", "Undo")],
)
def test_a_skeleton_keeps_translations_and_fills_the_rest(
    client, strategy, expected
) -> None:
    answer = _post(
        client,
        "skeleton",
        {
            "source": {"save": "Save", "undo": "Undo"},
            "target_locale": "fr",
            "existing_target": {"save": "Enregistrer"},
            "placeholder_strategy": strategy,
        },
    )

    assert answer["success"] is True
    assert answer["skeleton"] == {"save": "Enregistrer", "undo": expected}


def test_an_unknown_strategy_is_refused_by_name(client) -> None:
    for route, body in (
        ("skeleton", {"source": {}, "target_locale": "fr"}),
        ("report-from-dir", {"locales_dir": "/nowhere"}),
    ):
        answer = _post(client, route, {**body, "placeholder_strategy": "loud"})
        assert answer["success"] is False
        assert answer["error"]


def test_a_report_counts_each_locale_against_the_source(client, locales) -> None:
    answer = _post(client, "report-from-dir", {"locales_dir": str(locales)})

    assert answer["success"] is True
    assert answer["locales_found"] == ["en", "fr"]
    assert answer["redirected_from"] is None
    assert answer["layout"]
    assert json.dumps(answer["report"])


def test_a_report_on_one_language_reads_its_parent_and_says_so(client, locales) -> None:
    answer = _post(client, "report-from-dir", {"locales_dir": str(locales / "fr")})

    assert answer["success"] is True
    assert Path(answer["locales_dir"]) == locales.resolve()
    assert Path(answer["redirected_from"]) == (locales / "fr").resolve()


def test_a_folder_without_translations_says_what_it_expected(
    client, tmp_path: Path
) -> None:
    empty = tmp_path / "empty"
    empty.mkdir()

    answer = _post(client, "report-from-dir", {"locales_dir": str(empty)})

    assert answer["success"] is False
    assert answer["locales_found"] == []
    assert "empty/<lang>.json" in answer["error"]


def test_a_missing_source_locale_lists_the_locales_found(client, locales) -> None:
    answer = _post(
        client, "report-from-dir", {"locales_dir": str(locales), "source_locale": "de"}
    )

    assert answer["success"] is False
    assert answer["locales_found"] == ["en", "fr"]
    assert "'de'" in answer["error"] and "en, fr" in answer["error"]


def test_namespaces_of_a_folder_without_locales_is_a_plain_refusal(
    client, tmp_path: Path
) -> None:
    empty = tmp_path / "empty"
    empty.mkdir()

    answer = _post(client, "namespaces", {"locales_dir": str(empty)})

    assert answer["success"] is False
    assert "<lang>/*.json" in answer["error"]


def test_detect_finds_the_locale_folder_of_a_project(client, locales) -> None:
    answer = _post(client, "detect", {"project_dir": str(locales.parent)})

    assert answer["success"] is True
    assert [Path(r["path"]).name for r in answer["roots"]] == ["locales"]


@pytest.mark.parametrize(
    ("route", "body"),
    [
        ("report-from-dir", {"locales_dir": "{bad}"}),
        ("namespaces", {"locales_dir": "{bad}"}),
        ("namespace", {"locales_dir": "{bad}", "namespace": "common"}),
        ("mutate", {"locales_dir": "{bad}", "operations": []}),
        ("detect", {"project_dir": "{bad}"}),
    ],
)
def test_a_folder_that_does_not_exist_is_refused_before_it_is_read(
    client, tmp_path: Path, route, body
) -> None:
    bad = str(tmp_path / "missing" / ".." / "gone")
    body = {k: (bad if v == "{bad}" else v) for k, v in body.items()}

    answer = _post(client, route, body)

    assert answer["success"] is False
    assert not (tmp_path / "gone").exists()


@pytest.mark.parametrize(
    ("route", "body"),
    [
        ("namespaces", {"locales_dir": "/srv"}),
        ("namespace", {"locales_dir": "/srv"}),
        ("mutate", {"locales_dir": "/srv"}),
        ("detect", {"project_dir": "/srv"}),
    ],
)
def test_the_editor_refuses_server_mode(
    client, monkeypatch: pytest.MonkeyPatch, route, body
) -> None:
    import i18n_scaler.api as api

    monkeypatch.setattr(api, "server_mode_roots", lambda: [Path("/srv")])

    answer = _post(client, route, body)

    assert answer["success"] is False
    assert "server mode" in answer["error"]


@pytest.mark.parametrize(
    ("route", "body", "broken"),
    [
        ("diff", {"source": {}, "target": {}}, "I18nAutoScaler.diff"),
        (
            "skeleton",
            {"source": {}, "target_locale": "fr"},
            "I18nAutoScaler.generate_skeleton",
        ),
        ("report-from-dir", {"locales_dir": "{dir}"}, "I18nAutoScaler.report"),
        ("report-from-dir", {"locales_dir": "{dir}"}, "discover"),
        ("namespaces", {"locales_dir": "{dir}"}, "list_namespaces"),
        ("namespace", {"locales_dir": "{dir}"}, "load_namespace"),
        ("mutate", {"locales_dir": "{dir}"}, "apply_operations"),
        ("detect", {"project_dir": "{dir}"}, "find_locale_roots"),
    ],
)
def test_an_unexpected_failure_is_reported_without_its_detail(
    client, locales, monkeypatch: pytest.MonkeyPatch, route, body, broken
) -> None:
    import i18n_scaler.api as api

    def fail(*_a, **_k):
        raise RuntimeError("/home/someone/locales is unreadable")

    if broken == "discover":
        monkeypatch.setattr(api.I18nAutoScaler, "discover_locales", fail)
    elif "." in broken:
        monkeypatch.setattr(api.I18nAutoScaler, broken.split(".")[1], fail)
    else:
        monkeypatch.setattr(api, broken, fail)
    body = {k: (str(locales) if v == "{dir}" else v) for k, v in body.items()}

    answer = _post(client, route, body)

    assert answer["success"] is False
    assert "/home/someone" not in answer["error"]


def test_a_discovery_refusal_is_reported_without_a_path(
    client, locales, monkeypatch: pytest.MonkeyPatch
) -> None:
    import i18n_scaler.api as api

    def refuse(*_a, **_k):
        raise ValueError("Not a directory: /home/someone/locales")

    monkeypatch.setattr(api.I18nAutoScaler, "discover_locales", refuse)

    answer = _post(client, "report-from-dir", {"locales_dir": str(locales)})

    assert answer["success"] is False
    assert "/home/someone" not in answer["error"]


@pytest.mark.parametrize("route", ["namespaces", "detect"])
def test_an_editor_refusal_reads_from_the_reason_table(
    client, locales, monkeypatch: pytest.MonkeyPatch, route
) -> None:
    import i18n_scaler.api as api
    from i18n_scaler.editor import EditorError

    def refuse(*_a, **_k):
        raise EditorError("not-a-directory", "Not a directory: /home/someone")

    monkeypatch.setattr(
        api, "list_namespaces" if route == "namespaces" else "find_locale_roots", refuse
    )
    key = "locales_dir" if route == "namespaces" else "project_dir"

    answer = _post(client, route, {key: str(locales)})

    assert answer == {"success": False, "error": "That path is not a directory."}

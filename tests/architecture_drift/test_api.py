"""The Architecture Drift panel's routes, on a real layered project."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

RULES = {
    "architecture_style": "layered",
    "layers": [
        {"name": "domain", "patterns": ["domain/**"], "forbidden_imports": ["infra"]},
        {"name": "infra", "patterns": ["infra/**"], "allowed_imports": ["domain"]},
    ],
    "ai_review": False,
}


@pytest.fixture
def client() -> TestClient:
    from architecture_drift.api import router

    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


@pytest.fixture
def project(tmp_path: Path) -> Path:
    root = tmp_path / "shop"
    for package in ("domain", "infra"):
        (root / package).mkdir(parents=True)
        (root / package / "__init__.py").write_text("", encoding="utf-8")
    (root / "infra" / "db.py").write_text("CONNECTION = 1\n", encoding="utf-8")
    (root / "domain" / "orders.py").write_text("import infra.db\n", encoding="utf-8")
    (root / ".workpilot").mkdir()
    (root / ".workpilot" / "architecture_rules.json").write_text(
        json.dumps(RULES), encoding="utf-8"
    )
    return root


def _post(client: TestClient, route: str, project: Path) -> dict:
    return client.post(
        f"/api/architecture/drift/{route}", json={"project_path": str(project)}
    ).json()


def test_a_scan_reports_the_violation_of_the_written_rules(client, project) -> None:
    answer = _post(client, "scan", project)

    assert answer["success"] is True
    assert answer["config_source"] == "explicit"
    [violation] = answer["report"]["violations"]
    assert violation["file"] == "domain/orders.py"


def test_a_project_without_rules_is_scanned_with_inferred_ones(
    client, tmp_path: Path
) -> None:
    bare = tmp_path / "bare"
    bare.mkdir()
    (bare / "main.py").write_text("print('hi')\n", encoding="utf-8")

    answer = _post(client, "scan", bare)

    assert answer["success"] is True
    assert answer["config_source"] == "inferred"


def test_drift_is_what_appeared_since_the_saved_baseline(client, project) -> None:
    before = _post(client, "compare", project)
    assert before["drift"]["has_baseline"] is False

    saved = _post(client, "save-baseline", project)
    assert saved["success"] is True and saved["violation_count"] == 1
    assert Path(saved["baseline_path"]).is_file()

    (project / "domain" / "billing.py").write_text(
        "from infra import db\n", encoding="utf-8"
    )
    (project / "domain" / "orders.py").write_text("X = 1\n", encoding="utf-8")

    drift = _post(client, "compare", project)["drift"]

    assert drift["has_baseline"] is True
    assert [v["file"] for v in drift["new_violations"]] == ["domain/billing.py"]
    assert [v["file"] for v in drift["resolved_violations"]] == ["domain/orders.py"]


@pytest.mark.parametrize("route", ["scan", "save-baseline", "compare"])
def test_a_folder_that_is_not_a_project_is_refused(client, tmp_path, route) -> None:
    answer = _post(client, route, tmp_path / "missing" / ".." / "elsewhere")

    assert answer["success"] is False
    assert answer["error"]
    assert not (tmp_path / "elsewhere").exists()


@pytest.mark.parametrize("route", ["scan", "save-baseline", "compare"])
def test_a_failing_scan_is_reported_without_its_detail(
    client, project, monkeypatch: pytest.MonkeyPatch, route
) -> None:
    import architecture_drift.api as api

    def broken(_project):
        raise RuntimeError("/home/someone/shop is unreadable")

    monkeypatch.setattr(api, "_run_validation", broken)

    answer = _post(client, route, project)

    assert answer["success"] is False
    assert "/home/someone" not in answer["error"]

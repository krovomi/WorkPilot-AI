"""The Kanban card's ui-ux-pro-max routes, on a real project and spec folder."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from uiux.api import router, summarize_design


@pytest.fixture
def client() -> TestClient:
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


@pytest.fixture
def spec(tmp_path: Path) -> Path:
    project = tmp_path / "shop"
    folder = project / ".workpilot" / "specs" / "001-pricing-page"
    folder.mkdir(parents=True)
    (folder / "spec.md").write_text(
        "# Pricing page\n\nA new UI screen.\n", encoding="utf-8"
    )
    return folder


DESIGN = """# Design System

| Role | Hex |
|------|-----|
| Primary | `#2563eb` |
| Accent | #F97316 |

### Style
- **Name:** Soft UI
### Pattern
- **Name:** Hero + pricing grid
- **Heading Font:** Inter
**Body Font:** Source Sans
**Style:** ignored, the first value wins
"""


def test_the_design_summary_keeps_swatches_fonts_and_style() -> None:
    summary = summarize_design(DESIGN)

    assert summary == {
        "colors": [
            {"role": "Primary", "hex": "#2563EB"},
            {"role": "Accent", "hex": "#F97316"},
        ],
        "style": "Soft UI",
        "pattern": "Hero + pricing grid",
        "heading": "Inter",
        "body": "Source Sans",
    }


def test_before_a_build_the_card_gets_a_forecast(client, spec: Path) -> None:
    answer = client.get("/api/uiux/task", params={"spec_dir": str(spec)}).json()

    assert answer["success"] is True
    assert answer["record"] is None and answer["design"] is None
    assert answer["forecast"] is not None
    assert answer["installed"] in (True, False)
    if not answer["installed"]:
        assert answer["reason"]


def test_after_a_build_the_card_draws_the_design_it_wrote(client, spec: Path) -> None:
    uiux = spec / "uiux"
    uiux.mkdir()
    (uiux / "result.json").write_text(json.dumps({"status": "ready"}), encoding="utf-8")
    (uiux / "design-system.md").write_text(DESIGN, encoding="utf-8")

    answer = client.get(
        "/api/uiux/task",
        params={"project_dir": str(spec.parents[2]), "spec_id": spec.name},
    ).json()

    assert answer["record"]["status"] == "ready"
    assert answer["forecast"] is None
    assert answer["design"]["style"] == "Soft UI"


def test_a_record_without_its_design_file_draws_no_design(client, spec: Path) -> None:
    uiux = spec / "uiux"
    uiux.mkdir()
    (uiux / "result.json").write_text(
        json.dumps({"status": "withheld"}), encoding="utf-8"
    )

    answer = client.get("/api/uiux/task", params={"spec_dir": str(spec)}).json()

    assert answer["record"]["status"] == "withheld"
    assert answer["design"] is None


def test_a_spec_outside_a_project_has_no_forecast_project(
    client, tmp_path: Path
) -> None:
    loose = tmp_path / "loose-spec"
    loose.mkdir()

    answer = client.get("/api/uiux/task", params={"spec_dir": str(loose)}).json()

    assert answer["success"] is True
    assert answer["forecast"] is not None


def test_an_override_is_written_then_read_back(client, spec: Path) -> None:
    answer = client.post(
        "/api/uiux/override", json={"spec_dir": str(spec), "mode": "skip"}
    ).json()

    assert answer["success"] is True
    saved = json.loads((spec / "uiux" / "override.json").read_text(encoding="utf-8"))
    assert saved["mode"] == "skip"
    assert answer["forecast"]["override"] == "skip"


def test_an_unknown_override_mode_writes_nothing(client, spec: Path) -> None:
    answer = client.post(
        "/api/uiux/override", json={"spec_dir": str(spec), "mode": "always"}
    ).json()

    assert answer == {
        "success": False,
        "error": "invalid mode",
        "reason": "invalid-mode",
    }
    assert not (spec / "uiux").exists()


@pytest.mark.parametrize(
    "params",
    [{}, {"project_dir": "/work/shop", "spec_id": "../../etc"}],
)
def test_a_bad_address_is_refused_with_its_reason(client, params) -> None:
    answer = client.get("/api/uiux/task", params=params).json()

    assert answer["success"] is False
    assert answer["reason"] in ("addressing", "spec_id", "escapes", "traversal")
    assert answer["error"]

    refused = client.post("/api/uiux/override", json={**params, "mode": "auto"}).json()
    assert refused["success"] is False and refused["reason"] == answer["reason"]


def test_an_override_on_a_symlinked_folder_is_refused_quietly(
    client, spec: Path, tmp_path: Path
) -> None:
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    (spec / "uiux").symlink_to(elsewhere, target_is_directory=True)

    answer = client.post(
        "/api/uiux/override", json={"spec_dir": str(spec), "mode": "force"}
    ).json()

    assert answer == {"success": False, "error": "An internal error has occurred."}
    assert list(elsewhere.iterdir()) == []


def test_a_failed_status_hides_its_detail(
    client, spec: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import uiux.api as api

    def broken():
        raise OSError("/home/someone/.agents is unreadable")

    monkeypatch.setattr(api, "doctor", broken)

    answer = client.get("/api/uiux/task", params={"spec_dir": str(spec)}).json()

    assert answer == {"success": False, "error": "An internal error has occurred."}

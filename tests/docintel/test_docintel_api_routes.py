"""The docintel routes, when the address is wrong and when the work fails.

The route tests elsewhere follow a card from the first read to the decision
and the visual QA through its happy path. This file holds the other promise
every route makes: a request that names no task is refused before anything is
read, and a failure inside the work is answered with a fixed message, never
with the exception's text, which can carry a path or a value.
"""

from __future__ import annotations

import base64
from pathlib import Path

import pytest

fastapi = pytest.importorskip("fastapi")

from docintel import api, figma, visual_qa  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

INTERNAL = {"success": False, "error": "An internal error has occurred."}
SECRET_DETAIL = "/home/someone/.ssh/id_rsa"
PNG = "data:image/png;base64," + base64.b64encode(b"\x89PNG\r\n\x1a\n").decode()


@pytest.fixture
def client() -> TestClient:
    app = fastapi.FastAPI()
    app.include_router(api.router)
    return TestClient(app)


@pytest.fixture
def project(tmp_path: Path, monkeypatch) -> Path:
    monkeypatch.delenv(figma.TOKEN_ENV, raising=False)
    root = tmp_path / "project"
    (root / ".workpilot" / "specs" / "001-orders" / "attachments").mkdir(parents=True)
    return root


@pytest.fixture
def address(project: Path) -> dict:
    return {"project_dir": str(project), "spec_id": "001-orders"}


def broken(*_args, **_kwargs):
    raise RuntimeError(SECRET_DETAIL)


NO_TASK = {"spec_id": "../../etc"}

POSTS = [
    ("/api/docintel/drafts/extract", {}),
    ("/api/docintel/drafts/decide", {}),
    ("/api/docintel/whiteboard", {"path": "attachments/board.png"}),
    ("/api/docintel/figma", {"url": "https://www.figma.com/design/AbCdEf1234567890/x"}),
    ("/api/docintel/visual/run", {}),
    ("/api/docintel/captures", {"side": "task", "image": PNG}),
]


class TestAddressing:
    @pytest.mark.parametrize(("route", "extra"), POSTS)
    def test_a_post_that_names_no_task_is_refused(self, client, route, extra):
        body = client.post(route, json={**NO_TASK, **extra}).json()

        assert body["success"] is False and body["reason"]

    @pytest.mark.parametrize("route", ["/api/docintel/drafts", "/api/docintel/visual"])
    def test_a_read_that_names_no_task_is_refused(self, client, route):
        body = client.get(route, params=NO_TASK).json()

        assert body["success"] is False and body["reason"]


class TestFailuresSayNothingOfThemselves:
    @pytest.mark.parametrize(
        ("target", "name", "method", "route", "extra"),
        [
            (api, "run_preflight", "get", "/api/docintel/", {}),
            (api, "load_drafts", "get", "/api/docintel/drafts", {}),
            (api, "run_preflight", "post", "/api/docintel/drafts/extract", {}),
            (api, "decide", "post", "/api/docintel/drafts/decide", {}),
            (figma, "import_figma", "post", "/api/docintel/figma", POSTS[3][1]),
            (visual_qa, "load_visual_qa", "get", "/api/docintel/visual", {}),
            (visual_qa, "run_visual_qa", "post", "/api/docintel/visual/run", {}),
            (visual_qa, "save_capture", "post", "/api/docintel/captures", POSTS[5][1]),
        ],
    )
    def test_a_failure_is_a_fixed_message(
        self, client, address, monkeypatch, target, name, method, route, extra
    ):
        monkeypatch.setattr(target, name, broken)

        if method == "get":
            body = client.get(route, params=address).json()
        else:
            body = client.post(route, json={**address, **extra}).json()

        assert body == INTERNAL

    def test_a_whiteboard_that_fails_is_a_fixed_message(
        self, client, project, address, monkeypatch
    ):
        image_mod = pytest.importorskip("PIL.Image")
        spec = project / ".workpilot" / "specs" / "001-orders"
        image_mod.new("RGB", (8, 8)).save(spec / "attachments" / "board.png")
        monkeypatch.setattr(api, "convert", broken)

        body = client.post(
            "/api/docintel/whiteboard",
            json={**address, "path": "attachments/board.png"},
        ).json()

        assert body == INTERNAL

    def test_the_code_checks_failing_leave_the_card_standing(
        self, client, address, monkeypatch
    ):
        monkeypatch.setattr(api, "check_erd", broken)

        body = client.get("/api/docintel/", params=address).json()

        assert body["success"] is True and SECRET_DETAIL not in str(body)


class TestFigmaAndVision:
    def test_a_figma_link_without_a_token_says_so(self, client, address):
        body = client.post("/api/docintel/figma", json={**address, **POSTS[3][1]})

        assert body.json()["result"]["status"] == "no-token"

    def test_a_photo_with_local_ocr_switched_off_cannot_be_converted(
        self, client, project, address
    ):
        image_mod = pytest.importorskip("PIL.Image")
        spec = project / ".workpilot" / "specs" / "001-orders"
        image_mod.new("RGB", (8, 8)).save(spec / "attachments" / "board.png")
        (project / ".workpilot" / ".env").write_text(
            "DOCINTEL_LOCAL_OCR=false\n", encoding="utf-8"
        )

        vision = client.get("/api/docintel/drafts", params=address).json()["vision"]

        assert vision == {
            "images": ["attachments/board.png"],
            "available": False,
            "reason": "disabled",
        }

    def test_a_photo_says_whether_the_vision_model_answers(
        self, client, project, address, monkeypatch
    ):
        from docintel.engines.ollama_vision import OllamaVisionEngine

        image_mod = pytest.importorskip("PIL.Image")
        spec = project / ".workpilot" / "specs" / "001-orders"
        image_mod.new("RGB", (8, 8)).save(spec / "attachments" / "board.png")
        monkeypatch.setattr(
            OllamaVisionEngine, "available", lambda self, env: "model-not-installed"
        )

        vision = client.get("/api/docintel/drafts", params=address).json()["vision"]

        assert (vision["available"], vision["reason"]) == (
            False,
            "model-not-installed",
        )
        assert vision["model"]


class TestCaptures:
    def test_a_frame_that_is_no_base64_is_not_an_image(self, client, address):
        body = client.post(
            "/api/docintel/captures",
            json={**address, "side": "task", "image": "data:image/png;base64,@@@"},
        ).json()

        assert body["reason"] == "invalid-image"

    def test_a_frame_for_no_known_side_is_refused(self, client, address):
        body = client.post(
            "/api/docintel/captures",
            json={**address, "side": "sideways", "image": PNG},
        ).json()

        assert body == {
            "success": False,
            "error": "invalid-side",
            "reason": "invalid-side",
        }

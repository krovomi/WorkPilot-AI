"""Import Design's render loop wired to the pipeline: routes, skips, mirror, files."""

from __future__ import annotations

import asyncio
import base64
import importlib
import io
import json
import re
import types
from pathlib import Path

import httpx
import numpy as np
import pytest
from design_to_code.diff import JPEG_TOLERANCE
from design_to_code.loop import CorrectionError, LoopConfig
from design_to_code.preview import PREVIEW_PATH
from design_to_code.render import RenderError
from design_to_code.vision import VisionRoute
from PIL import Image
from services import design_to_code_render_loop as glue
from services.design_to_code_service import (
    ComponentSpec,
    DesignSpec,
    DesignToCodeService,
    GeneratedFile,
    PipelineResult,
)

RED, ORANGE = "#e63946", "#f08030"


def _draw(header: str) -> Image.Image:
    pixels = np.full((200, 300, 3), 255, dtype=np.uint8)
    pixels[:60, :] = [int(header[i : i + 2], 16) for i in (1, 3, 5)]
    return Image.fromarray(pixels)


def _data_url(image: Image.Image, fmt: str = "PNG") -> str:
    buffer = io.BytesIO()
    image.save(buffer, format=fmt)
    mime = "jpeg" if fmt == "JPEG" else "png"
    return f"data:image/{mime};base64," + base64.b64encode(buffer.getvalue()).decode()


class FakeRenderer:
    """Draws the header colour named in the rendered page."""

    pages: list[str] = []
    fail: str | None = None

    def __init__(self, width: int, height: int, *, executable: str = "") -> None:
        self.viewport = (width, height, 1)
        self.missing_fonts = ["Inter"]

    async def __aenter__(self):
        if FakeRenderer.fail:
            raise RenderError(FakeRenderer.fail)
        return self

    async def __aexit__(self, *exc) -> None:
        return None

    async def capture(self, files, page, fonts=None) -> bytes:
        FakeRenderer.pages.append(page)
        colour = re.search(r"#[0-9a-f]{6}", files[page]).group(0)
        buffer = io.BytesIO()
        _draw(colour).save(buffer, format="PNG")
        return buffer.getvalue()


@pytest.fixture
def world(monkeypatch, tmp_path):
    FakeRenderer.pages = []
    FakeRenderer.fail = None
    monkeypatch.setattr(glue, "Renderer", FakeRenderer)
    monkeypatch.setattr(glue, "active_provider", lambda: "anthropic")
    monkeypatch.setattr(glue, "airgap_strict", lambda path: False)
    monkeypatch.setattr(
        "services.design_to_code_service._claude_signed_in", lambda: False
    )
    for name in (
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "GOOGLE_API_KEY",
        "GEMINI_API_KEY",
    ):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-0000")
    service = DesignToCodeService(str(tmp_path))
    asked: list[tuple[str, str]] = []

    async def claude(self, key, image, prompt):
        asked.append((key, image))
        return json.dumps(
            {"edits": [{"path": "index.html", "find": ORANGE, "replace": RED}]}
        )

    monkeypatch.setattr(DesignToCodeService, "_call_claude_vision", claude)
    return {"service": service, "asked": asked}


def _result(files=None, components=None, simulated=False) -> PipelineResult:
    files = (
        files
        if files is not None
        else [
            GeneratedFile(
                "index.html", f'<header style="background:{ORANGE}"></header>', "html"
            ),
            GeneratedFile("styles.css", "header{}", "css"),
        ]
    )
    spec = DesignSpec(
        components=components
        or [
            ComponentSpec("Header", "header", bounds={"x": 0, "y": 0, "w": 1, "h": 0.3})
        ],
        typography={"body": {"fontFamily": "Inter, sans-serif"}},
    )
    return PipelineResult(
        success=True, design_spec=spec, generated_files=files, simulated=simulated
    )


def _loop(world, result, *, image=None, framework="html", events=None):
    return asyncio.run(
        glue.run_render_loop(
            world["service"],
            result,
            image_data=image or _data_url(_draw(RED)),
            framework=framework,
            config=LoopConfig(),
            on_progress=events.append if events is not None else None,
        )
    )


def test_the_html_page_is_corrected_until_it_matches(world) -> None:
    result = _result()
    events: list = []
    report = _loop(world, result, events=events)
    assert report["status"] == "converged" and report["route"] == "claude_api"
    assert report["mirror"] is False and report["missing_fonts"] == ["Inter"]
    assert report["viewport"] == {"width": 300, "height": 200, "scale": 1}
    assert (
        result.generated_files[0].content
        == f'<header style="background:{RED}"></header>'
    )
    assert result.generated_files[1].content == "header{}"
    assert FakeRenderer.pages == ["index.html", "index.html"]
    assert world["asked"][0][0] == "sk-test-0000"
    assert world["asked"][0][1].startswith("data:image/png;base64,")
    assert events and events[0]["stage"] == "render"


def test_a_jpeg_target_is_compared_with_a_wider_tolerance(world) -> None:
    report = _loop(world, _result(), image=_data_url(_draw(RED), "JPEG"))
    assert report["tolerance"] == JPEG_TOLERANCE


def test_a_non_html_stack_renders_a_mirror_and_never_delivers_it(
    world, monkeypatch
) -> None:
    prompts: list[str] = []

    async def oneshot(prompt, **kwargs):
        prompts.append(prompt)
        return f'```html\n<!DOCTYPE html><header style="background:{ORANGE}"></header>\n```'

    async def claude(self, key, image, prompt):
        return json.dumps(
            {
                "edits": [
                    {"path": PREVIEW_PATH, "find": ORANGE, "replace": RED},
                    {"path": "src/Header.tsx", "find": ORANGE, "replace": RED},
                ]
            }
        )

    monkeypatch.setattr("core.oneshot.oneshot_completion", oneshot)
    monkeypatch.setattr(DesignToCodeService, "_call_claude_vision", claude)
    result = _result([GeneratedFile("src/Header.tsx", f"const c = '{ORANGE}';", "tsx")])
    report = _loop(world, result, framework="react")
    assert report["status"] == "converged" and report["mirror"] is True
    assert "The React files" in prompts[0]
    assert FakeRenderer.pages[0] == PREVIEW_PATH
    assert [f.path for f in result.generated_files] == ["src/Header.tsx"]
    assert RED in result.generated_files[0].content


def test_an_html_stack_without_a_page_falls_back_to_the_mirror(
    world, monkeypatch
) -> None:
    async def oneshot(prompt, **kwargs):
        return "no html, sorry"

    monkeypatch.setattr("core.oneshot.oneshot_completion", oneshot)
    report = _loop(world, _result([GeneratedFile("a.css", "x", "css")]))
    assert report["status"] == "skipped" and report["reason"] == "no_preview"


@pytest.mark.parametrize(
    ("result", "image", "reason"),
    [
        (_result(simulated=True), None, "no_model"),
        (_result(files=[]), None, "no_files"),
        (_result(), "data:image/svg+xml;base64,PHN2Zy8+", "unsupported_target"),
        (_result(), "data:image/png;base64,abc", "unsupported_target"),
        (_result(), "data:image/png;base64,AAAA", "unsupported_target"),
    ],
)
def test_a_run_the_loop_cannot_help_is_skipped_with_its_reason(
    world, result, image, reason
) -> None:
    report = _loop(world, result, image=image)
    assert report["status"] == "skipped" and report["reason"] == reason
    assert report["iterations"] == [] and world["asked"] == []


def test_a_provider_without_vision_is_refused_by_name(world, monkeypatch) -> None:
    monkeypatch.setattr(glue, "active_provider", lambda: "deepseek")
    report = _loop(world, _result())
    assert (report["reason"], report["provider"]) == ("no_vision_route", "deepseek")


def test_a_local_model_that_is_not_running_is_reported(world, monkeypatch) -> None:
    monkeypatch.setattr(glue, "airgap_strict", lambda path: True)
    monkeypatch.setenv("DOCINTEL_VISION_MODEL", "local-vision-model")
    monkeypatch.setattr(
        "docintel.engines.ollama_vision.OllamaVisionEngine.available",
        lambda self, env: "server-unreachable",
    )
    report = _loop(world, _result())
    assert (
        report["reason"] == "local_unavailable"
        and report["detail"] == "server-unreachable"
    )
    assert report["model"] == "local-vision-model"


def test_a_local_model_that_runs_corrects_on_the_machine(world, monkeypatch) -> None:
    monkeypatch.setattr(glue, "airgap_strict", lambda path: True)
    monkeypatch.setattr(
        "docintel.engines.ollama_vision.OllamaVisionEngine.available",
        lambda self, env: None,
    )
    seen: dict = {}

    def ask(image, prompt, env):
        seen["model"] = env["DOCINTEL_VISION_MODEL"]
        seen["png"] = Path(image).read_bytes()[:4]
        return json.dumps(
            {"edits": [{"path": "index.html", "find": ORANGE, "replace": RED}]}
        ), ""

    monkeypatch.setattr("docintel.engines.ollama_vision.ask", ask)
    report = _loop(world, _result())
    assert report["status"] == "converged" and report["route"] == "ollama"
    assert seen["png"] == b"\x89PNG" and world["asked"] == []


def test_no_browser_skips_the_loop(world) -> None:
    FakeRenderer.fail = "no_browser"
    report = _loop(world, _result())
    assert report["status"] == "skipped" and report["reason"] == "no_browser"


def _correct(service, route):
    return glue.make_corrector(service, VisionRoute("x", route=route, model="m"))


def test_each_cloud_route_calls_its_own_vision_call(monkeypatch, tmp_path) -> None:
    service = DesignToCodeService(str(tmp_path))
    calls: list[tuple] = []

    def record(name):
        async def call(self, *args):
            calls.append((name, args[0] if len(args) == 3 else None))
            return name

        return call

    for name in (
        "_call_claude_subscription_vision",
        "_call_openai_vision",
        "_call_gemini_vision",
    ):
        monkeypatch.setattr(DesignToCodeService, name, record(name))
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-0001")
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    monkeypatch.setenv("GEMINI_API_KEY", "gm-test-0000")
    for route in ("claude_subscription", "openai", "google"):
        asyncio.run(_correct(service, route)("p", b"png"))
    assert calls == [
        ("_call_claude_subscription_vision", None),
        ("_call_openai_vision", "sk-test-0001"),
        ("_call_gemini_vision", "gm-test-0000"),
    ]


def test_a_provider_failure_names_its_kind_never_its_text(
    monkeypatch, tmp_path
) -> None:
    service = DesignToCodeService(str(tmp_path))
    monkeypatch.setenv("GOOGLE_API_KEY", "gm-test-0000")
    request = httpx.Request("POST", "https://example.invalid/?key=gm-test-0000")

    async def status_error(self, *args):
        raise httpx.HTTPStatusError(
            "bad ?key=gm-test-0000",
            request=request,
            response=httpx.Response(403, request=request),
        )

    monkeypatch.setattr(DesignToCodeService, "_call_gemini_vision", status_error)
    with pytest.raises(CorrectionError) as error:
        asyncio.run(_correct(service, "google")("p", b"png"))
    assert str(error.value) == "provider answered HTTP 403"

    async def broken(self, *args):
        raise KeyError("content gm-test-0000")

    monkeypatch.setattr(DesignToCodeService, "_call_gemini_vision", broken)
    with pytest.raises(CorrectionError) as error:
        asyncio.run(_correct(service, "google")("p", b"png"))
    assert str(error.value) == "provider call failed (KeyError)"


def test_a_local_model_without_an_answer_is_a_correction_error(
    monkeypatch, tmp_path
) -> None:
    monkeypatch.setattr(
        "docintel.engines.ollama_vision.ask", lambda image, prompt, env: ("", "timeout")
    )
    with pytest.raises(CorrectionError, match="local vision model: timeout"):
        asyncio.run(_correct(DesignToCodeService(str(tmp_path)), "ollama")("p", b"png"))


def test_the_layout_masks_dynamic_zones_and_falls_back_to_bands() -> None:
    spec = DesignSpec(
        components=[
            ComponentSpec(
                "Hero <img>", "Image", bounds={"x": 0, "y": 0, "w": 1, "h": 0.5}
            ),
            ComponentSpec("!!!", "card", bounds={"x": 0, "y": 0.5, "w": 1, "h": 0.5}),
            ComponentSpec("Floating", "button"),
            ComponentSpec(
                "Dot", "icon", bounds={"x": 0, "y": 0, "w": 0.001, "h": 0.001}
            ),
        ]
    )
    regions, masks, masked = glue.layout(spec, 400, 300)
    assert [r.name for r in regions] == ["zone 2"]
    assert masked == ["Hero img"] and masks[0].h == 150
    regions, masks, masked = glue.layout(None, 400, 300)
    assert len(regions) == 5 and masks == [] and masked == []


def test_targets_decode_from_a_data_url_or_bare_base64() -> None:
    assert glue.decode_target("AAAA") == (b"\x00\x00\x00", "image/png")
    assert glue.decode_target("data:image/jpeg;base64,AAAA") == (
        b"\x00\x00\x00",
        "image/jpeg",
    )
    assert glue.decode_target("data:;base64,AAAA") == (b"\x00\x00\x00", "image/png")
    assert glue.decode_target("abc") is None


def test_the_local_vision_model_is_the_setting_then_the_chosen_local_model(
    monkeypatch,
) -> None:
    for name in ("DOCINTEL_VISION_MODEL", "OLLAMA_MODEL", "LOCAL_LLM_MODEL"):
        monkeypatch.delenv(name, raising=False)
    from docintel.settings import DEFAULT_VISION_MODEL

    assert glue.local_vision_model() == DEFAULT_VISION_MODEL
    monkeypatch.setenv("LOCAL_LLM_MODEL", "local-a")
    assert glue.local_vision_model() == "local-a"
    monkeypatch.setenv("OLLAMA_MODEL", "local-b")
    assert glue.local_vision_model() == "local-b"
    monkeypatch.setenv("DOCINTEL_VISION_MODEL", " local-c ")
    assert glue.local_vision_model() == "local-c"


def test_the_subscription_model_is_the_one_the_page_would_use(
    monkeypatch, tmp_path
) -> None:
    service = DesignToCodeService(str(tmp_path))
    monkeypatch.setattr("core.oneshot._resolve_model", lambda *args: "default")
    assert glue.route_models(service)["claude_subscription"] == service.vision_model
    monkeypatch.setattr(
        "core.oneshot._resolve_model", lambda *args: "subscription-vision-model"
    )
    assert (
        glue.route_models(service)["claude_subscription"] == "subscription-vision-model"
    )


def test_credentials_are_read_as_booleans(monkeypatch) -> None:
    monkeypatch.setattr(
        "services.design_to_code_service._claude_signed_in", lambda: True
    )
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    monkeypatch.setenv("GEMINI_API_KEY", "gm-test-0000")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-0000")
    creds = glue.credentials()
    assert (
        creds.anthropic_key,
        creds.openai_key,
        creds.google_key,
        creds.claude_signed_in,
    ) == (
        False,
        True,
        True,
        True,
    )


def test_the_provider_and_the_offline_policy_are_read_from_their_sources(
    monkeypatch, tmp_path
) -> None:
    # The module the glue imports at call time, even if a test swapped it.
    client = importlib.import_module("core.client")
    monkeypatch.setattr(
        client, "peek_active_provider", lambda spec_dir=None: " Ollama "
    )
    assert glue.active_provider() == "ollama"
    project = tmp_path / "p"
    (project / ".workpilot").mkdir(parents=True)
    assert glue.airgap_strict(project) is False
    (project / ".workpilot" / "offline-mode.json").write_text(
        '{"airgapStrict": true}', encoding="utf-8"
    )
    assert glue.airgap_strict(project) is True


def test_the_passes_asked_for_run_on_the_version_kept(world, monkeypatch) -> None:
    seen: list = []

    async def responsive(renderer, files, page, **kwargs):
        seen.append(("responsive", files[page], kwargs["threshold"]))
        return {"status": "done", "breakpoints": []}

    async def states(renderer, files, page):
        seen.append(("states", files[page]))
        raise RenderError("load_failed")

    monkeypatch.setattr(glue, "responsive_pass", responsive)
    monkeypatch.setattr(glue, "states_pass", states)
    events: list = []
    report = asyncio.run(
        glue.run_render_loop(
            world["service"],
            _result(),
            image_data=_data_url(_draw(RED)),
            framework="html",
            config=LoopConfig(responsive=True, states=True),
            on_progress=events.append,
        )
    )
    kept = f'<header style="background:{RED}"></header>'
    assert seen == [("responsive", kept, 0.95), ("states", kept)]
    assert report["responsive"] == {"status": "done", "breakpoints": []}
    assert report["states"] == {"status": "failed", "detail": "load_failed"}
    stages = [e["stage"] for e in events]
    assert stages[-2:] == ["responsive", "states"]
    assert events[-1]["iteration"] == report["best_iteration"]
    # The provider reported no tokens here: the spend is an estimate.
    assert report["spend"]["estimated"] and report["spend"]["tokens"] > 0


def test_no_pass_runs_when_not_asked_or_when_nothing_was_rendered(world) -> None:
    report = _loop(world, _result())
    assert "responsive" not in report and "states" not in report

    outcome = types.SimpleNamespace(iterations=[])

    async def scenario():
        return await glue.run_passes(
            None,
            outcome,
            "index.html",
            target=None,
            regions=[],
            masks=[],
            config=LoopConfig(responsive=True, states=True),
            on_progress=None,
        )

    assert asyncio.run(scenario()) == {}


def test_the_passes_run_without_a_progress_callback(world, monkeypatch) -> None:
    async def states(renderer, files, page):
        return {"status": "done", "elements": []}

    monkeypatch.setattr(glue, "states_pass", states)
    report = asyncio.run(
        glue.run_render_loop(
            world["service"],
            _result(),
            image_data=_data_url(_draw(RED)),
            framework="html",
            config=LoopConfig(states=True),
        )
    )
    assert report["states"] == {"status": "done", "elements": []}


@pytest.mark.parametrize(
    ("route", "model", "status"),
    [
        ("claude_api", "claude-opus-5", "priced"),
        ("openai", "gpt-4o", "priced"),
        ("claude_subscription", "claude-opus-5", "flat_rate"),
        ("ollama", "llava", "flat_rate"),
        ("google", "gemini-1.5-flash", "unknown"),
        ("claude_api", "", "unknown"),
    ],
)
def test_the_cost_comes_from_the_catalogue_or_is_unknown(route, model, status) -> None:
    from design_to_code.budget import Usage

    pricing = glue.pricing_for(VisionRoute("x", route=route, model=model))
    assert pricing.status == status
    if status == "unknown":
        assert pricing.price is None
    elif status == "flat_rate":
        assert pricing.price(Usage(1_000_000, 1_000_000)) == 0.0
    else:
        assert pricing.price(Usage(1_000_000, 0, 0, 0)) > 0


def test_the_correction_carries_the_tokens_its_provider_reported(
    monkeypatch, tmp_path
) -> None:
    from design_to_code.budget import Usage

    service = DesignToCodeService(str(tmp_path))
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-0001")

    async def openai(self, key, image, prompt):
        self.last_usage = Usage(5, 6)
        return "answer"

    monkeypatch.setattr(DesignToCodeService, "_call_openai_vision", openai)
    reply = asyncio.run(_correct(service, "openai")("p", b"png"))
    assert (reply.text, reply.usage) == ("answer", Usage(5, 6))

    monkeypatch.setattr(
        "docintel.engines.ollama_vision.ask", lambda image, prompt, env: ("local", "")
    )
    service.last_usage = Usage(1, 1)
    reply = asyncio.run(_correct(service, "ollama")("p", b"png"))
    assert (reply.text, reply.usage) == ("local", None)


def test_the_openai_and_gemini_models_are_the_ones_called(
    monkeypatch, tmp_path
) -> None:
    monkeypatch.delenv("DESIGN_TO_CODE_VISION_MODEL_GOOGLE", raising=False)
    models = glue.route_models(DesignToCodeService(str(tmp_path)))
    assert (models["openai"], models["google"]) == ("gpt-4o", "gemini-1.5-flash")

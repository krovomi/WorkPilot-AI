"""Design-to-code: what the project, the models and Figma answer at the edges.

The token files of a real folder, the answers a model may give (fenced, broken,
of the wrong shape), the Figma comment of every stack, and the image sent
without its data URI. Network calls go through a recording mock transport.
"""

from __future__ import annotations

import json
import logging
import sys
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from design_to_code.budget import Usage
from services.design_to_code_service import (
    ComponentSpec,
    DesignSpec,
    DesignToCodeService,
    DesignToken,
    DesignTokenExtractor,
    FrameworkType,
    GeneratedFile,
    LayoutSpec,
    PipelinePhase,
    VisualTestGenerator,
    _claude_signed_in,
    run_design_to_code_pipeline,
)
from services.design_to_code_stacks import component_name

B64 = "iVBORw0KGgoAAAANSUhEUg=="
KEY = "sk-test-0000"  # pragma: allowlist secret
FIGMA = "figd-test-0000"  # pragma: allowlist secret


@pytest.fixture(autouse=True)
def no_keys(monkeypatch: pytest.MonkeyPatch) -> None:
    for key in (
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "GOOGLE_API_KEY",
        "GEMINI_API_KEY",
        "FIGMA_ACCESS_TOKEN",
    ):
        monkeypatch.delenv(key, raising=False)


@pytest.fixture
def service(tmp_path: Path) -> DesignToCodeService:
    return DesignToCodeService(str(tmp_path))


@pytest.fixture
def network(monkeypatch: pytest.MonkeyPatch) -> dict:
    """Each httpx request, answered by host; ``status`` makes every answer fail."""
    state: dict = {"sent": [], "status": 200}
    real = httpx.AsyncClient

    def handler(request: httpx.Request) -> httpx.Response:
        state["sent"].append(request)
        if state["status"] != 200:
            return httpx.Response(state["status"], json={"err": "no"})
        if request.url.host == "api.anthropic.com":
            return httpx.Response(200, json={"content": [{"text": "claude"}]})
        if request.url.host == "generativelanguage.googleapis.com":
            return httpx.Response(
                200, json={"candidates": [{"content": {"parts": [{"text": "g"}]}}]}
            )
        return httpx.Response(200, json={"id": "c1"})

    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda *a, **k: real(*a, transport=httpx.MockTransport(handler), **k),
    )
    return state


def _write(root: Path, rel: str, text: str) -> None:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


# --- the project's token files ------------------------------------------------


def test_scss_and_js_theme_files_give_their_tokens(tmp_path: Path) -> None:
    _write(tmp_path, "styles/_variables.scss", "$brand-color: #ff0000;\n$gap-sm: 4px;")
    _write(
        tmp_path,
        "tailwind.config.js",
        "module.exports = { colors: { 'accent': '#00ff00', ink: 'rgb(1, 2, 3)' } }",
    )

    tokens = {
        t.name: (t.value, t.category) for t in DesignTokenExtractor(tmp_path).extract()
    }

    assert tokens["$brand-color"] == ("#ff0000", "color")
    assert tokens["$gap-sm"] == ("4px", "spacing")
    assert tokens["accent"] == ("#00ff00", "color")
    assert tokens["ink"] == ("rgb(1, 2, 3)", "color")


def test_a_token_file_too_deep_is_not_read(tmp_path: Path) -> None:
    _write(tmp_path, "a/b/c/d/e/tokens.json", '{"near": {"$value": "1px"}}')
    _write(tmp_path, "a/b/c/d/e/f/tokens.json", '{"far": {"$value": "2px"}}')

    names = [t.name for t in DesignTokenExtractor(tmp_path).extract()]

    assert names == ["near"]


def test_unreadable_and_broken_files_give_nothing_but_do_not_stop_the_scan(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    (tmp_path / "theme").mkdir()
    (tmp_path / "theme" / "variables.css").write_bytes(b"--a: \xff\xfe;")
    _write(tmp_path, "src/tokens.json", "{not json")
    _write(
        tmp_path,
        "design-tokens.json",
        json.dumps(
            {
                "$schema": {"x": {"$value": "ignored"}},
                "list": ["#fff"],
                "deep": {"ok": {"$value": "#123456", "$type": "color"}},
            }
        ),
    )

    with caplog.at_level(logging.WARNING):
        tokens = DesignTokenExtractor(tmp_path).extract()

    assert [(t.name, t.value) for t in tokens] == [("deep.ok", "#123456")]
    assert any("Could not parse token file" in r.message for r in caplog.records)


def test_a_folder_that_refuses_listing_is_skipped(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write(tmp_path, "locked/tokens.json", '{"hidden": {"$value": "1"}}')
    _write(tmp_path, "open/tokens.json", '{"seen": {"$value": "2"}}')
    real = Path.iterdir

    def iterdir(self: Path):
        if self.name == "locked":
            raise PermissionError(self)
        return real(self)

    monkeypatch.setattr(Path, "iterdir", iterdir)

    assert [t.name for t in DesignTokenExtractor(tmp_path).extract()] == ["seen"]


@pytest.mark.parametrize(
    ("name", "category"),
    [
        ("brand-bg", "color"),
        ("font-weight-bold", "typography"),
        ("line-height-lg", "typography"),
        ("padding-x", "spacing"),
        ("shadow-md", "shadow"),
        ("elevation-2", "shadow"),
        ("rounded-lg", "border"),
        ("screen-md", "breakpoint"),
        ("z-index-modal", "other"),
    ],
)
def test_a_token_name_says_its_category(name: str, category: str) -> None:
    assert DesignTokenExtractor._guess_category(name) == category


def test_the_token_context_is_capped_per_category(tmp_path: Path) -> None:
    extractor = DesignTokenExtractor(tmp_path)
    assert extractor.get_tokens_as_context() == "No design tokens found in the project."

    extractor.tokens = [DesignToken(f"c{i}", "#000", "color") for i in range(32)]
    extractor.tokens.append(DesignToken("gap", "4px", "spacing"))
    context = extractor.get_tokens_as_context()

    assert "### Color" in context
    assert "  - `c29`: #000" in context and "`c30`" not in context
    assert context.count("more") == 1 and "  ... and 2 more" in context
    assert "### Spacing\n  - `gap`: 4px\n" in context


# --- visual tests -----------------------------------------------------------------


def test_one_visual_test_per_component_even_when_files_repeat_it() -> None:
    files = [
        GeneratedFile("src/Card.tsx", "", "tsx"),
        GeneratedFile("src/card/Card.tsx", "", "tsx"),
        GeneratedFile("src/Card.module.css", "", "css"),
    ]

    tests = VisualTestGenerator(FrameworkType.REACT).generate_tests(files)

    assert [t.name for t in tests] == ["CardVisualTest"]


def test_a_file_named_only_by_punctuation_names_no_component() -> None:
    assert component_name("src/components/---.tsx") is None
    assert component_name("index.tsx") is None


# --- callbacks ------------------------------------------------------------------


def test_a_phase_callback_that_fails_to_print_does_not_stop_the_others(
    service: DesignToCodeService,
) -> None:
    seen: list = []

    def broken(*_args):
        raise OSError("console closed")

    service.on_phase_change(broken)
    service.on_phase_change(lambda phase, status: seen.append((phase, status)))
    service.on_progress(broken)
    service.on_progress(lambda phase, status, detail: seen.append(detail))

    service._set_phase(PipelinePhase.ANALYZING, "go", {"n": 1})

    assert seen == [(PipelinePhase.ANALYZING, "go"), {"n": 1}]
    assert service.phase is PipelinePhase.ANALYZING


# --- the design analysis a model answers ------------------------------------------


def test_a_fenced_analysis_is_read_with_its_nested_components(
    service: DesignToCodeService,
) -> None:
    raw = (
        "```json\n"
        + json.dumps(
            {
                "components": [
                    {
                        "name": "Hero",
                        "type": "section",
                        "children": [{"name": "Title", "type": "h1"}, "noise"],
                    },
                    "noise",
                ],
                "layout": {"type": "grid", "gap": "8px"},
                "color_palette": {"primary": "#3B82F6"},
            }
        )
        + "\n```"
    )

    spec = service._parse_design_analysis(raw)

    assert [c.name for c in spec.components] == ["Hero"]
    assert [c.name for c in spec.components[0].children] == ["Title"]
    assert (spec.layout.type, spec.layout.gap, spec.layout.direction) == (
        "grid",
        "8px",
        "column",
    )
    assert spec.raw_analysis == raw


def test_an_analysis_whose_fence_is_never_closed_is_still_read(
    service: DesignToCodeService,
) -> None:
    spec = service._parse_design_analysis('```json\n{"components": [{"name": "A"}]}')

    assert [c.name for c in spec.components] == ["A"]


@pytest.mark.parametrize("raw", ["not json at all", "[1, 2]", '"text"'])
def test_an_analysis_that_is_not_an_object_keeps_only_the_raw_answer(
    service: DesignToCodeService, raw: str
) -> None:
    spec = service._parse_design_analysis(raw)

    assert spec.components == [] and spec.layout is None
    assert spec.raw_analysis == raw


def test_a_layout_of_the_wrong_shape_falls_back_to_the_defaults(
    service: DesignToCodeService,
) -> None:
    spec = service._parse_design_analysis('{"layout": "grid", "components": {}}')

    assert spec.layout == LayoutSpec(type="flex")
    assert spec.components == []


# --- tokens in the spec -------------------------------------------------------------


def test_colors_are_mapped_to_the_project_tokens(service: DesignToCodeService) -> None:
    spec = DesignSpec(
        color_palette={"primary": "#3B82F6", "accent": "#00FF00", "other": "#123"}
    )
    tokens = [
        DesignToken("--color-primary", "#3b82f6", "color"),
        DesignToken("$accent", " #00ff00 ", "color"),
        DesignToken("--space", "#123", "spacing"),
    ]

    assert service._enrich_spec_with_tokens(spec, []) is spec
    service._enrich_spec_with_tokens(spec, tokens)

    assert spec.color_palette == {
        "primary": "var(--color-primary)",
        "accent": "$accent",
        "other": "#123",
    }


def test_the_spec_context_holds_every_section_given(
    service: DesignToCodeService,
) -> None:
    full = DesignSpec(
        components=[
            ComponentSpec(
                name="Nav",
                type="nav",
                styles={"bg": "#fff"},
                interactions=["hover"],
                accessibility={"role": "navigation"},
                description="Top bar",
                children=[ComponentSpec(name="Logo", type="img")],
            ),
            ComponentSpec(name="Plain", type="div"),
        ],
        layout=LayoutSpec(type="flex"),
        color_palette={"primary": "#000"},
        typography={"h1": {"size": "32px"}},
        interactions=[{"trigger": "click"}],
        responsive_notes=["Stack on mobile"],
    )

    context = service._spec_to_context(full)

    for line in (
        "### Layout",
        "- Type: flex",
        "- primary: #000",
        '- h1: {"size": "32px"}',
        "#### Nav (nav)",
        'Styles: {"bg": "#fff"}',
        "Interactions: hover",
        'Accessibility: {"role": "navigation"}',
        "Children: Logo",
        "#### Plain (div)",
        '- {"trigger": "click"}',
        "- Stack on mobile",
    ):
        assert line in context
    assert service._spec_to_context(DesignSpec()) == "## Design Specification\n"


# --- the files a model answers ------------------------------------------------------


def test_fenced_files_are_read_and_odd_entries_dropped(
    service: DesignToCodeService,
) -> None:
    raw = (
        "```\n"
        + json.dumps(
            [{"path": "src/A.tsx", "content": "x", "language": "tsx"}, "noise", 3]
        )
        + "\n```"
    )

    files = service._parse_generated_files(raw)

    assert [(f.path, f.content, f.language) for f in files] == [
        ("src/A.tsx", "x", "tsx")
    ]


def test_files_whose_fence_is_never_closed_are_still_read(
    service: DesignToCodeService,
) -> None:
    files = service._parse_generated_files('```json\n[{"path": "src/B.tsx"}]')

    assert [(f.path, f.content, f.language) for f in files] == [
        ("src/B.tsx", "", "text")
    ]


async def test_the_code_comes_from_the_active_provider_when_it_answers(
    service: DesignToCodeService, monkeypatch: pytest.MonkeyPatch
) -> None:
    prompts: list[str] = []

    async def oneshot(prompt: str, **kwargs) -> str:
        prompts.append(prompt)
        return "[]"

    monkeypatch.setattr("core.oneshot.oneshot_completion", oneshot)

    assert await service._call_code_generation_ai("make it") == "[]"
    assert prompts == ["make it"]


@pytest.mark.parametrize(
    "raw", ["{broken", '{"path": "src/A.tsx", "content": "x"}', "42"]
)
def test_an_answer_that_is_not_a_list_of_files_is_kept_as_raw_output(
    service: DesignToCodeService, raw: str
) -> None:
    [only] = service._parse_generated_files(raw)

    assert (only.path, only.content, only.language) == (
        "generated_output.txt",
        raw,
        "text",
    )


async def test_a_model_answering_one_object_still_completes_the_pipeline(
    service: DesignToCodeService, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def one_object(prompt: str) -> str:
        return '{"path": "src/A.tsx", "content": "x"}'

    monkeypatch.setattr(service, "_call_code_generation_ai", one_object)

    result = await service.run_pipeline(image_data=B64, generate_tests=False)

    assert result.success is True, result.errors
    assert [f.path for f in result.generated_files] == ["generated_output.txt"]


# --- the image without its data URI ---------------------------------------------------


async def test_a_bare_image_is_sent_as_png(
    service: DesignToCodeService, network: dict
) -> None:
    assert await service._call_claude_vision(KEY, B64, "p") == "claude"
    body = json.loads(network["sent"][-1].content)
    assert body["messages"][0]["content"][0]["source"] == {
        "type": "base64",
        "media_type": "image/png",
        "data": B64,
    }

    assert await service._call_gemini_vision(KEY, B64, "p") == "g"
    part = json.loads(network["sent"][-1].content)["contents"][0]["parts"]
    assert {"inline_data": {"mime_type": "image/png", "data": B64}} in part


class _Subscription:
    def __init__(self, messages: list) -> None:
        self.messages = messages
        self.sent: list = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def query(self, prompt):
        self.sent.extend([m async for m in prompt])

    async def receive_response(self):
        for message in self.messages:
            yield message


async def test_the_subscription_sends_a_bare_image_as_png(
    service: DesignToCodeService, monkeypatch: pytest.MonkeyPatch
) -> None:
    client = _Subscription(
        [
            SimpleNamespace(
                content=[SimpleNamespace(text=None), SimpleNamespace(text=" seen ")]
            ),
            SimpleNamespace(total_cost_usd=0.0, usage={"input_tokens": 3}),
        ]
    )
    monkeypatch.setattr(
        "core.simple_client.create_simple_client", lambda **kwargs: client
    )

    assert await service._call_claude_subscription_vision(B64, "p") == "seen"
    source = client.sent[0]["message"]["content"][0]["source"]
    assert (source["media_type"], source["data"]) == ("image/png", B64)
    assert service.last_usage == Usage(3, 0)


async def test_a_subscription_that_says_nothing_is_an_error(
    service: DesignToCodeService, monkeypatch: pytest.MonkeyPatch
) -> None:
    client = _Subscription([SimpleNamespace(content=[SimpleNamespace(text="  ")])])
    monkeypatch.setattr(
        "core.simple_client.create_simple_client", lambda **kwargs: client
    )

    with pytest.raises(RuntimeError, match="no analysis"):
        await service._call_claude_subscription_vision(B64, "p")


@pytest.mark.parametrize(
    ("answer", "signed_in"),
    [("tok", True), ("", False), (OSError("no keychain"), False)],
)
def test_the_claude_sign_in_is_read_from_the_keychain(
    monkeypatch: pytest.MonkeyPatch, answer, signed_in: bool
) -> None:
    def token():
        if isinstance(answer, Exception):
            raise answer
        return answer

    monkeypatch.setattr("core.auth.get_auth_token", token)

    assert _claude_signed_in() is signed_in


# --- Figma ----------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("framework", "files", "names"),
    [
        (
            FrameworkType.REACT,
            [
                ("src/PricingCard.tsx", "tsx"),
                ("src/pricing/index.tsx", "tsx"),
                ("src/PricingCard.module.css", "css"),
            ],
            ["PricingCard", "Pricing"],
        ),
        (
            FrameworkType.FLUTTER,
            [
                ("lib/pricing_card.dart", "dart"),
                ("lib/pricing_card.g.dart", "dart"),
                ("lib/pricing_card.json", "json"),
            ],
            ["PricingCard"],
        ),
        (
            FrameworkType.ANGULAR,
            [
                ("src/app/pricing-card.component.ts", "ts"),
                ("src/app/pricing.service.ts", "ts"),
            ],
            ["PricingCard"],
        ),
    ],
)
async def test_figma_hears_of_the_components_of_every_stack(
    service: DesignToCodeService,
    network: dict,
    monkeypatch: pytest.MonkeyPatch,
    framework: FrameworkType,
    files: list[tuple[str, str]],
    names: list[str],
) -> None:
    monkeypatch.setenv("FIGMA_ACCESS_TOKEN", FIGMA)
    generated = [GeneratedFile(path, "", language) for path, language in files]

    status = await service._sync_figma("FileKey1", "1:2", generated, framework)

    assert status == {
        "status": "synced",
        "file_key": "FileKey1",
        "node_id": "1:2",
        "components_synced": names,
    }
    [request] = network["sent"]
    body = json.loads(request.content)
    assert f"Components: {', '.join(names)}\n" in body["message"]
    assert f"Files generated: {len(files)}\n" in body["message"]
    assert body["client_meta"] == {"node_id": "1:2"}
    assert request.url.path == "/v1/files/FileKey1/comments"


async def test_a_figma_refusal_is_reported_not_raised(
    service: DesignToCodeService, network: dict, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("FIGMA_ACCESS_TOKEN", FIGMA)
    network["status"] = 403

    status = await service._sync_figma("FileKey1", None, [])

    assert status["status"] == "error"
    assert "403" in status["error"]


async def test_without_the_figma_connector_the_sync_is_skipped(
    service: DesignToCodeService, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("FIGMA_ACCESS_TOKEN", FIGMA)
    monkeypatch.setitem(sys.modules, "src.connectors.figma_connector", None)

    status = await service._sync_figma("FileKey1", None, [])

    assert status == {"status": "skipped", "reason": "Figma connector not available"}


async def test_the_pipeline_syncs_figma_with_the_chosen_stack(
    tmp_path: Path, network: dict, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("FIGMA_ACCESS_TOKEN", FIGMA)
    service = DesignToCodeService(str(tmp_path))

    async def dart(prompt: str) -> str:
        return json.dumps([{"path": "lib/hero_card.dart", "language": "dart"}])

    monkeypatch.setattr(service, "_call_code_generation_ai", dart)

    result = await service.run_pipeline(
        image_data=B64, framework="flutter", figma_file_key="FileKey1"
    )

    assert result.success is True, result.errors
    assert result.figma_sync_status["components_synced"] == ["HeroCard"]


# --- the convenience entry point --------------------------------------------------------


async def test_the_pipeline_entry_point_returns_what_the_renderer_reads(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("core.oneshot.oneshot_completion", lambda *a, **k: _empty())

    result = await run_design_to_code_pipeline(str(tmp_path), B64, framework="wpf")

    assert result["success"] is True
    assert result["simulated"] is True
    assert result["phase"] == "complete"
    assert "visual_tests_unsupported" in result["warnings"]


async def _empty() -> str:
    return ""

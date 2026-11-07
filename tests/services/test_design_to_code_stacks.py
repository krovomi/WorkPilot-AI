"""Import Design: every stack, live progress, project confinement, honest fallbacks."""

import asyncio
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "apps" / "backend"))

from services.design_to_code_service import (
    DesignToCodeService,
    DesignTokenExtractor,
    FrameworkType,
    GeneratedFile,
    PipelinePhase,
    PipelineResult,
    VisualTest,
    VisualTestGenerator,
    _parse_bounds,
    serialize_result,
)
from services.design_to_code_stacks import (
    STACKS,
    build_visual_test,
    component_name,
    get_stack,
    is_component_file,
    style_instruction,
)

PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=="


class TestStackRegistry:
    def test_every_framework_has_a_stack_and_back(self):
        assert {f.value for f in FrameworkType} == set(STACKS)

    def test_stacks_cover_web_mobile_and_desktop(self):
        groups = {s.group for s in STACKS.values()}
        assert groups == {"web", "mobile", "desktop"}
        for stack_id in ("blazor", "flutter", "swiftui", "jetpack_compose", "maui"):
            assert stack_id in STACKS

    def test_unknown_stack_falls_back_to_react(self):
        assert get_stack("cobol").id == "react"
        assert get_stack(None).id == "react"

    def test_nuxt_and_next_have_their_own_prompt(self):
        # They used to fall back to the React prompt (Nuxt then got React code).
        assert "Nuxt" in get_stack("nuxt").prompt
        assert "Next.js" in get_stack("nextjs").prompt
        assert get_stack("nuxt").prompt != get_stack("react").prompt

    def test_style_hint_only_for_web_stacks(self):
        assert "Tailwind" in style_instruction(get_stack("vue"), "tailwind")
        assert style_instruction(get_stack("flutter"), "tailwind") == ""
        assert style_instruction(get_stack("react"), "unknown") == ""


class TestComponents:
    @pytest.mark.parametrize(
        ("path", "expected"),
        [
            ("src/components/PricingCard.tsx", "PricingCard"),
            ("lib/widgets/pricing_card.dart", "PricingCard"),
            ("src/app/pricing-card/pricing-card.component.ts", "PricingCard"),
            ("src/components/Hero/index.tsx", "Hero"),
            ("Views/PricingCard.xaml", "PricingCard"),
        ],
    )
    def test_component_name(self, path, expected):
        assert component_name(path) == expected

    def test_angular_component_files_only(self):
        angular = get_stack("angular")
        assert is_component_file(angular, "src/app/a/a.component.ts", "ts")
        assert not is_component_file(angular, "src/app/a/a.service.ts", "ts")

    def test_tests_and_stories_are_not_components(self):
        react = get_stack("react")
        assert not is_component_file(react, "src/Card.test.tsx", "tsx")
        assert not is_component_file(react, "src/Card.stories.tsx", "tsx")
        assert is_component_file(react, "src/Card.tsx", "tsx")


class TestVisualTestsPerStack:
    @pytest.mark.parametrize(
        ("stack_id", "path_part", "code_part"),
        [
            ("react", "tests/visual/pricing-card.spec.ts", "toHaveScreenshot"),
            ("blazor", "tests/visual/pricing-card.spec.ts", "toHaveScreenshot"),
            (
                "flutter",
                "test/goldens/pricing_card_golden_test.dart",
                "matchesGoldenFile",
            ),
            (
                "swiftui",
                "Tests/SnapshotTests/PricingCardSnapshotTests.swift",
                "assertSnapshot",
            ),
            ("jetpack_compose", "PricingCardScreenshotTest.kt", "paparazzi.snapshot"),
            (
                "react_native",
                "__tests__/PricingCard.snapshot.test.tsx",
                "toMatchSnapshot",
            ),
        ],
    )
    def test_each_stack_gets_its_own_convention(self, stack_id, path_part, code_part):
        draft = build_visual_test(get_stack(stack_id), "PricingCard")
        assert draft is not None
        assert path_part in draft.path
        assert code_part in draft.code

    def test_web_tests_cover_three_viewports(self):
        draft = build_visual_test(get_stack("vue"), "Header")
        for size in ("1280", "768", "375"):
            assert size in draft.code

    @pytest.mark.parametrize("stack_id", ["maui", "wpf", "avalonia"])
    def test_stacks_without_convention_get_no_fake_test(self, stack_id):
        generator = VisualTestGenerator(FrameworkType(stack_id))
        files = [GeneratedFile("Views/Card.xaml", "<UserControl/>", "xaml")]
        assert generator.supported is False
        assert generator.generate_tests(files) == []

    def test_generator_sets_the_test_path(self):
        generator = VisualTestGenerator(FrameworkType.FLUTTER)
        files = [
            GeneratedFile("lib/widgets/hero_banner.dart", "class HeroBanner {}", "dart")
        ]
        tests = generator.generate_tests(files)
        assert len(tests) == 1
        assert isinstance(tests[0], VisualTest)
        assert tests[0].path == "test/goldens/hero_banner_golden_test.dart"


class TestTokenConfinement:
    def _tokens_outside(self, tmp_path: Path) -> Path:
        outside = tmp_path / "outside"
        outside.mkdir()
        (outside / "variables.css").write_text(
            ":root { --secret-color: #ff0000; }", encoding="utf-8"
        )
        project = tmp_path / "project"
        project.mkdir()
        return project

    def test_relative_escape_is_ignored(self, tmp_path):
        project = self._tokens_outside(tmp_path)
        tokens = DesignTokenExtractor(project).extract("../outside")
        assert all(t.name != "--secret-color" for t in tokens)

    def test_absolute_path_is_ignored(self, tmp_path):
        project = self._tokens_outside(tmp_path)
        tokens = DesignTokenExtractor(project).extract(str(tmp_path / "outside"))
        assert all(t.name != "--secret-color" for t in tokens)

    def test_build_outputs_are_skipped_and_tokens_deduplicated(self, tmp_path):
        css = ":root { --brand: #e8642a; }"
        (tmp_path / "src").mkdir()
        (tmp_path / "src" / "variables.css").write_text(css, encoding="utf-8")
        for skipped in ("node_modules", "bin", "dist"):
            (tmp_path / skipped).mkdir()
            (tmp_path / skipped / "variables.css").write_text(
                ":root { --leak: #000; }", encoding="utf-8"
            )
        tokens = DesignTokenExtractor(tmp_path).extract()
        names = [t.name for t in tokens]
        assert names.count("--brand") == 1
        assert "--leak" not in names


class TestBounds:
    def test_fractions_are_kept(self):
        assert _parse_bounds({"x": 0.1, "y": 0.2, "w": 0.5, "h": 0.3}) == {
            "x": 0.1,
            "y": 0.2,
            "w": 0.5,
            "h": 0.3,
        }

    @pytest.mark.parametrize(
        "raw",
        [
            None,
            "x",
            {"x": 10, "y": 20, "w": 300, "h": 40},
            {"x": 0.1},
            {"x": 0, "y": 0, "w": 0, "h": 1},
        ],
    )
    def test_unusable_bounds_are_dropped(self, raw):
        assert _parse_bounds(raw) is None

    def test_box_is_clamped_to_the_image(self):
        box = _parse_bounds({"x": 0.8, "y": 0.9, "w": 0.5, "h": 0.5})
        assert box["w"] == pytest.approx(0.2)
        assert box["h"] == pytest.approx(0.1)


def _no_provider_env():
    return patch.dict("os.environ", {}, clear=True)


class TestPipelineProgress:
    @pytest.mark.asyncio
    async def test_progress_carries_the_spec_and_the_simulated_flag(self, tmp_path):
        service = DesignToCodeService(str(tmp_path))
        events = []
        service.on_progress(
            lambda phase, status, detail: events.append((phase, detail))
        )
        with (
            _no_provider_env(),
            patch(
                "services.design_to_code_service._claude_signed_in", return_value=False
            ),
        ):
            result = await service.run_pipeline(image_data=PNG, framework="flutter")

        phases = [p for p, _ in events]
        assert phases[0] == PipelinePhase.ANALYZING
        assert PipelinePhase.CODE_GENERATION in phases
        assert phases[-1] == PipelinePhase.COMPLETE
        spec_events = [
            d for p, d in events if p == PipelinePhase.DESIGN_TOKEN_INTEGRATION
        ]
        assert spec_events and "components" in spec_events[0]["spec"]
        # A canned example answered: the result must say so.
        assert result.simulated is True
        assert serialize_result(result)["simulated"] is True

    @pytest.mark.asyncio
    async def test_tokens_can_be_skipped(self, tmp_path):
        (tmp_path / "variables.css").write_text(
            ":root { --brand: #fff; }", encoding="utf-8"
        )
        service = DesignToCodeService(str(tmp_path))
        with (
            _no_provider_env(),
            patch(
                "services.design_to_code_service._claude_signed_in", return_value=False
            ),
        ):
            result = await service.run_pipeline(image_data=PNG, use_design_tokens=False)
        assert result.design_tokens_used == []

    @pytest.mark.asyncio
    async def test_unsupported_visual_tests_are_reported(self, tmp_path):
        service = DesignToCodeService(str(tmp_path))
        with (
            _no_provider_env(),
            patch(
                "services.design_to_code_service._claude_signed_in", return_value=False
            ),
        ):
            result = await service.run_pipeline(image_data=PNG, framework="maui")
        assert result.visual_tests == []
        assert "visual_tests_unsupported" in result.warnings


class _FakeSdkClient:
    def __init__(self, answer: str):
        self.answer = answer
        self.sent = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def query(self, prompt):
        async for message in prompt:
            self.sent.append(message)

    async def receive_response(self):
        yield SimpleNamespace(content=[SimpleNamespace(text=self.answer)])


class TestClaudeSubscriptionVision:
    @pytest.mark.asyncio
    async def test_signed_in_claude_reads_the_image_without_tools(self, tmp_path):
        service = DesignToCodeService(str(tmp_path))
        fake = _FakeSdkClient('{"components": []}')
        captured = {}

        def fake_create(**kwargs):
            captured.update(kwargs)
            return fake

        with (
            _no_provider_env(),
            patch.object(service, "_resolve_active_provider", return_value="claude"),
            patch(
                "services.design_to_code_service._claude_signed_in", return_value=True
            ),
            patch("core.simple_client.create_simple_client", side_effect=fake_create),
        ):
            answer = await service._call_vision_ai(PNG, "describe")

        assert answer == '{"components": []}'
        assert service._simulated is False
        # The tool-less type: what is written on the picture cannot open a file.
        assert captured["agent_type"] == "commit_message"
        content = fake.sent[0]["message"]["content"]
        assert content[0]["type"] == "image"
        assert content[0]["source"]["media_type"] == "image/png"
        assert content[1] == {"type": "text", "text": "describe"}


class TestRunnerWritesStayInside:
    def test_paths_outside_the_output_dir_are_skipped(self, tmp_path):
        from runners.design_to_code_runner import DesignToCodeRunner

        out = tmp_path / "project"
        out.mkdir()
        runner = DesignToCodeRunner(project_dir=str(out), output_dir=str(out))
        result = PipelineResult(
            success=True,
            generated_files=[
                GeneratedFile("src/Card.tsx", "ok", "tsx"),
                GeneratedFile("../escape.txt", "bad", "text"),
                GeneratedFile(str(tmp_path / "abs.txt"), "bad", "text"),
            ],
            visual_tests=[
                VisualTest("CardVisualTest", "t", path="tests/visual/card.spec.ts")
            ],
        )
        asyncio.run(runner._write_generated_files(result))

        assert (out / "src" / "Card.tsx").read_text(encoding="utf-8") == "ok"
        assert (out / "tests" / "visual" / "card.spec.ts").exists()
        assert not (tmp_path / "escape.txt").exists()
        assert not (tmp_path / "abs.txt").exists()


class TestRunnerEndToEnd:
    def test_runner_reads_an_image_file_and_returns_the_full_result(self, tmp_path):
        """The runner crashed on its first line (debug helpers called without
        their module) and on image files (aiofiles is not a dependency)."""
        import base64

        from runners.design_to_code_runner import DesignToCodeRunner

        image = tmp_path / "design.png"
        image.write_bytes(base64.b64decode("iVBORw0KGgoAAAANSUhEUg=="))
        project = tmp_path / "project"
        project.mkdir()
        runner = DesignToCodeRunner(
            project_dir=str(project),
            image_path=str(image),
            framework="vue",
            write_files=False,
        )
        with (
            _no_provider_env(),
            patch(
                "services.design_to_code_service._claude_signed_in", return_value=False
            ),
        ):
            result = asyncio.run(runner.run())

        assert result["success"] is True
        assert result["simulated"] is True
        assert result["generated_files"]
        # --no-write: the desktop app reviews the files before writing them.
        assert list(project.iterdir()) == []

#!/usr/bin/env python3
"""
Design-to-Code Runner - Convert visual designs to production-ready code

This runner orchestrates the Design-to-Code pipeline:
1. Accepts a design image (screenshot, Figma, wireframe, whiteboard photo)
2. Analyzes with Vision AI (Claude Vision, GPT-4o)
3. Generates structured component specification
4. Produces pixel-perfect code for the target framework
5. Integrates project design tokens
6. Generates visual regression tests
7. Optionally syncs with Figma bidirectionally
"""

import argparse
import asyncio
import json
import sys
from pathlib import Path

# Add auto-claude to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from cli.utils import import_dotenv
from foundation.debug import (
    debug,
    debug_error,
    debug_section,
    debug_success,
)
from services.design_to_code_stacks import STACKS, STYLE_HINTS

PHASE_PREFIX = "__DESIGN_TO_CODE_PHASE__:"
_MODULE = "design_to_code"

# Load .env file
load_dotenv = import_dotenv()
env_file = Path(__file__).parent.parent.parent.parent / ".env-files" / ".env"
if env_file.exists():
    load_dotenv(env_file)


class DesignToCodeRunner:
    """Runner for the Design-to-Code pipeline."""

    def __init__(
        self,
        project_dir: str,
        image_path: str = "",
        image_data: str = "",
        framework: str = "react",
        source_type: str = "screenshot",
        design_system_path: str = "",
        figma_url: str = "",
        generate_tests: bool = True,
        custom_instructions: str = "",
        output_dir: str = "",
        style: str = "",
        use_design_tokens: bool = True,
        write_files: bool = True,
        render_loop: bool = False,
        loop_max_iterations: int = 5,
        loop_threshold: float = 0.95,
        loop_budget_seconds: float = 600.0,
        loop_max_tokens: int = 400_000,
        loop_max_cost_usd: float = 2.0,
        loop_responsive: bool = False,
        loop_states: bool = False,
        loop_fix_passes: bool = False,
        loop_masks: tuple[tuple[float, float, float, float], ...] = (),
    ):
        self.project_dir = Path(project_dir)
        self.image_path = image_path
        self.image_data = image_data
        self.framework = framework
        self.source_type = source_type
        self.design_system_path = design_system_path
        self.figma_url = figma_url
        self.generate_tests = generate_tests
        self.custom_instructions = custom_instructions
        self.output_dir = output_dir or str(self.project_dir)
        self.style = style
        self.use_design_tokens = use_design_tokens
        # The desktop app reviews the files first and writes them itself
        # (``--no-write``); the CLI writes them where it was told.
        self.write_files = write_files
        # Render → diff → correct after the generation (#379).
        self.render_loop = render_loop
        self.loop_max_iterations = loop_max_iterations
        self.loop_threshold = loop_threshold
        self.loop_budget_seconds = loop_budget_seconds
        self.loop_max_tokens = loop_max_tokens
        self.loop_max_cost_usd = loop_max_cost_usd
        self.loop_responsive = loop_responsive
        self.loop_states = loop_states
        self.loop_fix_passes = loop_fix_passes
        self.loop_masks = loop_masks

    async def run(self) -> dict:
        """Run the complete design-to-code pipeline."""
        debug_section(_MODULE, "Design-to-Code Pipeline")
        debug(_MODULE, f"Project: {self.project_dir}")
        debug(_MODULE, f"Framework: {self.framework}")
        debug(_MODULE, f"Source type: {self.source_type}")

        # Resolve image data
        image_data = await self._resolve_image_data()
        if not image_data:
            debug_error(_MODULE, "No image data provided")
            return {
                "success": False,
                "error": "No image data provided. Provide --image-path or --image-data.",
            }

        # Parse Figma URL if provided
        figma_file_key = None
        figma_node_id = None
        if self.figma_url:
            from src.connectors.figma_connector import FigmaConnector

            parsed = FigmaConnector.parse_figma_url(self.figma_url)
            if parsed:
                figma_file_key = parsed.get("file_key")
                figma_node_id = parsed.get("node_id")
                debug(_MODULE, f"Figma file: {figma_file_key}, node: {figma_node_id}")

        # Run the pipeline
        from services.design_to_code_service import DesignToCodeService

        service = DesignToCodeService(str(self.project_dir))

        # Register phase callback for console output
        def on_phase(phase, status):
            phase_icons = {
                "analyzing": "🔍",
                "spec_generation": "📋",
                "code_generation": "💻",
                "design_token_integration": "🎨",
                "visual_test_generation": "🧪",
                "figma_sync": "🔄",
                "complete": "✅",
                "error": "❌",
            }
            icon = phase_icons.get(phase.value, "⏳")
            print(f"  {icon} [{phase.value}] {status}")

        def on_progress(phase, status, detail):
            # Structured line the Electron service forwards to the page live.
            payload = {"phase": phase.value, "status": status, "detail": detail}
            print(f"{PHASE_PREFIX}{json.dumps(payload)}", flush=True)

        service.on_phase_change(on_phase)
        service.on_progress(on_progress)

        result = await service.run_pipeline(
            image_data=image_data,
            framework=self.framework,
            design_system_path=self.design_system_path or None,
            source_type=self.source_type,
            figma_file_key=figma_file_key,
            figma_node_id=figma_node_id,
            generate_tests=self.generate_tests,
            custom_instructions=self.custom_instructions,
            style=self.style,
            use_design_tokens=self.use_design_tokens,
        )

        loop_report = None
        if self.render_loop and result.success:
            loop_report = await self._run_render_loop(service, result, image_data)

        # Write generated files to disk
        if self.write_files and result.success and result.generated_files:
            await self._write_generated_files(result)

        # Print summary
        self._print_summary(result)

        data = self._serialize_result(result)
        if loop_report is not None:
            data["render_loop"] = loop_report
        return data

    async def _run_render_loop(self, service, result, image_data: str) -> dict:
        """Refine the generated files against the design; the loop's report."""
        from design_to_code.loop import LoopConfig
        from services.design_to_code_render_loop import run_render_loop

        def on_loop(detail: dict) -> None:
            payload = {"phase": "render_loop", "status": "", "detail": {"loop": detail}}
            print(f"{PHASE_PREFIX}{json.dumps(payload)}", flush=True)

        config = LoopConfig(
            max_iterations=self.loop_max_iterations,
            threshold=self.loop_threshold,
            budget_seconds=self.loop_budget_seconds,
            max_tokens=self.loop_max_tokens,
            max_cost_usd=self.loop_max_cost_usd,
            responsive=self.loop_responsive,
            states=self.loop_states,
            fix_passes=self.loop_fix_passes,
            masks=self.loop_masks,
        )
        return await run_render_loop(
            service,
            result,
            image_data=image_data,
            framework=self.framework,
            config=config,
            on_progress=on_loop,
        )

    async def _resolve_image_data(self) -> str:
        """Resolve image data from path, base64, or Figma URL."""
        import base64

        # Direct base64 data
        if self.image_data:
            return self.image_data

        # Load from file
        if self.image_path:
            path = Path(self.image_path)
            if not path.exists():
                debug_error(_MODULE, f"Image file not found: {self.image_path}")
                return ""

            # aiofiles is not a dependency of the backend: plain reads.
            data = path.read_bytes()

            # Detect MIME type
            mime_map = {
                ".png": "image/png",
                ".jpg": "image/jpeg",
                ".jpeg": "image/jpeg",
                ".gif": "image/gif",
                ".webp": "image/webp",
                ".svg": "image/svg+xml",
            }
            mime = mime_map.get(path.suffix.lower(), "image/png")
            b64 = base64.b64encode(data).decode("utf-8")
            return f"data:{mime};base64,{b64}"

        # Load from Figma, a cloud service: refused under strict offline mode.
        if self.figma_url:
            from services.design_to_code_providers import guard_cloud

            guard_cloud(self.project_dir)
            try:
                from src.connectors.figma_connector import FigmaConnector

                connector = FigmaConnector()
                parsed = connector.parse_figma_url(self.figma_url)
                if parsed and parsed.get("node_id"):
                    debug(
                        _MODULE,
                        f"Exporting image from Figma node {parsed['node_id']}...",
                    )
                    export = await connector.export_node_image(
                        parsed["file_key"], parsed["node_id"]
                    )
                    if export.image_data:
                        return f"data:image/png;base64,{export.image_data}"
            except Exception as e:
                debug_error(_MODULE, f"Could not fetch Figma image: {e}")

        return ""

    async def _write_generated_files(self, result) -> None:
        """Write generated files under the output directory, never outside it.

        Paths come from the model: ``../`` or an absolute path is skipped.
        """
        output_base = Path(self.output_dir).resolve()

        def target(relative: str) -> Path | None:
            if not relative or Path(relative).is_absolute():
                return None
            resolved = (output_base / relative).resolve()
            return resolved if output_base in resolved.parents else None

        entries = [(gf.path, gf.content) for gf in result.generated_files]
        entries += [
            (vt.path or f"tests/visual/{vt.name}.spec.ts", vt.test_code)
            for vt in result.visual_tests
        ]
        print(f"\n📁 Writing {len(entries)} files:")
        for relative, content in entries:
            file_path = target(relative)
            if file_path is None:
                print(f"  ⛔ skipped (outside the output directory): {relative}")
                continue
            file_path.parent.mkdir(parents=True, exist_ok=True)
            file_path.write_text(content, encoding="utf-8")
            print(f"  ✅ {relative}")

    def _print_summary(self, result) -> None:
        """Print a pipeline summary."""
        print("\n" + "=" * 60)
        if result.success:
            debug_success(_MODULE, "Design-to-Code Pipeline Complete!")
            print(f"  📄 Files generated: {len(result.generated_files)}")
            print(f"  🧪 Visual tests: {len(result.visual_tests)}")
            print(f"  🎨 Design tokens used: {len(result.design_tokens_used)}")
            if result.design_spec:
                print(
                    f"  🧩 Components identified: {len(result.design_spec.components)}"
                )
            if result.figma_sync_status:
                sync = result.figma_sync_status.get("status", "unknown")
                print(f"  🔄 Figma sync: {sync}")
            print(f"  ⏱️  Duration: {result.duration_seconds:.1f}s")
        else:
            debug_error(_MODULE, "Pipeline Failed!")
            for error in result.errors:
                print(f"  ❌ {error}")
        print("=" * 60)

    def _serialize_result(self, result) -> dict:
        """Serialize the full pipeline result for the renderer."""
        return serialize_for_renderer(result)


def serialize_for_renderer(result) -> dict:
    """The pipeline result, scored with the Accessibility page's rules (#391).

    The score is added here, not in the service: ``services`` sits in the
    agent runtime's import cycle and the accessibility agent must stay out of it.
    """
    from accessibility_agent.generated import check_generated
    from services.design_to_code_service import serialize_result

    data = serialize_result(result)
    data["accessibility"] = check_generated(
        {f.path: f.content for f in result.generated_files}
    )
    return data


def _bounded_int(low: int, high: int):
    def parse(value: str) -> int:
        number = int(value)
        if not low <= number <= high:
            raise argparse.ArgumentTypeError(f"expected {low}-{high}")
        return number

    return parse


def _bounded_float(low: float, high: float):
    def parse(value: str) -> float:
        number = float(value)
        if not low <= number <= high:
            raise argparse.ArgumentTypeError(f"expected {low}-{high}")
        return number

    return parse


#: Zones the person may draw on the design for the render loop, at most.
MAX_LOOP_MASKS = 12


def _mask(value: str) -> tuple[float, float, float, float]:
    """``x,y,w,h`` as fractions of the design, inside it and not empty."""
    try:
        x, y, w, h = (float(part) for part in value.split(","))
    except ValueError as exc:
        raise argparse.ArgumentTypeError("expected x,y,w,h") from exc
    finite = all(0.0 <= v <= 1.0 for v in (x, y, w, h))
    if not finite or w <= 0 or h <= 0 or x + w > 1.0001 or y + h > 1.0001:
        raise argparse.ArgumentTypeError("expected fractions inside the design")
    return x, y, w, h


async def main():
    """CLI entry point for the Design-to-Code runner."""
    parser = argparse.ArgumentParser(
        description="Design-to-Code Pipeline — Convert visual designs to production-ready code"
    )
    parser.add_argument(
        "--project-dir", required=True, help="Path to the project directory"
    )
    parser.add_argument(
        "--image-path", default="", help="Path to the design image file"
    )
    parser.add_argument("--image-data", default="", help="Base64-encoded image data")
    parser.add_argument(
        "--framework",
        default="react",
        choices=sorted(STACKS),
        help="Target stack (default: react)",
    )
    parser.add_argument(
        "--style",
        default="",
        choices=["", *sorted(STYLE_HINTS)],
        help="Styling approach for web stacks",
    )
    parser.add_argument(
        "--no-tokens",
        action="store_true",
        help="Do not read the project's design tokens",
    )
    parser.add_argument(
        "--no-write",
        action="store_true",
        help="Return the files without writing them (the caller reviews them)",
    )
    parser.add_argument(
        "--source-type",
        default="screenshot",
        choices=["screenshot", "figma", "wireframe", "whiteboard", "photo"],
        help="Type of design source (default: screenshot)",
    )
    parser.add_argument(
        "--design-system-path", default="", help="Path to the project's design system"
    )
    parser.add_argument(
        "--figma-url", default="", help="Figma file/node URL for bidirectional sync"
    )
    parser.add_argument(
        "--no-tests", action="store_true", help="Skip visual test generation"
    )
    parser.add_argument(
        "--instructions", default="", help="Additional instructions for code generation"
    )
    parser.add_argument(
        "--output-dir", default="", help="Output directory (default: project dir)"
    )
    parser.add_argument(
        "--render-loop",
        action="store_true",
        help="Render the generated code, compare it with the design and correct it",
    )
    parser.add_argument(
        "--loop-max-iterations",
        type=_bounded_int(1, 10),
        default=5,
        help="Corrections the render loop may make (1-10, default 5)",
    )
    parser.add_argument(
        "--loop-threshold",
        type=_bounded_float(0.5, 0.999),
        default=0.95,
        help="Score at which the render loop stops (0.5-0.999, default 0.95)",
    )
    parser.add_argument(
        "--loop-budget-seconds",
        type=_bounded_float(30, 3600),
        default=600.0,
        help="Time the render loop may spend (30-3600 s, default 600)",
    )
    parser.add_argument(
        "--loop-max-tokens",
        type=_bounded_int(10_000, 5_000_000),
        default=400_000,
        help="Tokens the corrections may spend (10000-5000000, default 400000)",
    )
    parser.add_argument(
        "--loop-max-cost",
        type=_bounded_float(0.01, 100),
        default=2.0,
        help="US dollars the corrections may spend, when the model is priced "
        "(0.01-100, default 2)",
    )
    parser.add_argument(
        "--loop-responsive",
        action="store_true",
        help="Render the version kept at the mobile, tablet and desktop widths",
    )
    parser.add_argument(
        "--loop-states",
        action="store_true",
        help="Capture hover and focus of the first interactive elements",
    )
    parser.add_argument(
        "--loop-fix-passes",
        action="store_true",
        help="Send what the passes found back to the model once, kept if it helps",
    )
    parser.add_argument(
        "--loop-mask",
        type=_mask,
        action="append",
        default=[],
        help=f"A zone of the design left out of the score, x,y,w,h as fractions "
        f"(repeatable, at most {MAX_LOOP_MASKS})",
    )
    parser.add_argument("--json", action="store_true", help="Output result as JSON")

    args = parser.parse_args()
    if len(args.loop_mask) > MAX_LOOP_MASKS:
        parser.error(f"--loop-mask: at most {MAX_LOOP_MASKS}")

    runner = DesignToCodeRunner(
        project_dir=args.project_dir,
        image_path=args.image_path,
        image_data=args.image_data,
        framework=args.framework,
        source_type=args.source_type,
        design_system_path=args.design_system_path,
        figma_url=args.figma_url,
        generate_tests=not args.no_tests,
        custom_instructions=args.instructions,
        output_dir=args.output_dir,
        style=args.style,
        use_design_tokens=not args.no_tokens,
        write_files=not args.no_write,
        render_loop=args.render_loop,
        loop_max_iterations=args.loop_max_iterations,
        loop_threshold=args.loop_threshold,
        loop_budget_seconds=args.loop_budget_seconds,
        loop_max_tokens=args.loop_max_tokens,
        loop_max_cost_usd=args.loop_max_cost,
        loop_responsive=args.loop_responsive,
        loop_states=args.loop_states,
        loop_fix_passes=args.loop_fix_passes,
        loop_masks=tuple(args.loop_mask),
    )

    try:
        result = await runner.run()
    except Exception as exc:  # noqa: BLE001 — surface any failure to the UI
        # Structured error line parsed by the Electron design-to-code service.
        print(f"__DESIGN_TO_CODE_ERROR__:{exc}", flush=True)
        sys.exit(1)

    # Early-return failures (e.g. no resolvable image) come back as a minimal
    # dict; normalize so the renderer always receives the full result shape.
    if not result.get("success") and "generated_files" not in result:
        message = result.get("error", "Design-to-code pipeline failed")
        print(f"__DESIGN_TO_CODE_ERROR__:{message}", flush=True)
        sys.exit(1)

    if args.json:
        print(json.dumps(result, indent=2))

    # Structured result line parsed by the Electron design-to-code service.
    print(f"__DESIGN_TO_CODE_RESULT__:{json.dumps(result)}", flush=True)

    sys.exit(0 if result.get("success") else 1)


if __name__ == "__main__":
    from foundation.log_redaction import install_global_redaction

    install_global_redaction()
    asyncio.run(main())

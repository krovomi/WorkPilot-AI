"""Import Design's render loop, wired to the live pipeline (#379).

``run_render_loop`` takes a successful ``PipelineResult`` and refines its files
with ``design_to_code.loop``: it picks the vision route the person's provider
allows (``design_to_code.vision``), builds the page the browser opens, and
hands the loop a ``correct`` callable answered in the edits' schema on every
route (``design_to_code_edit_calls``): the Claude subscription through the
SDK's structured output, Claude's API, OpenAI, Gemini, LM Studio and llama.cpp
through the service's own vision calls with ``forced=True``, Ollama through
``docintel``'s local vision model with the schema as its ``format``. The files of the best version replace the generated ones; the loop's
report is returned for the page, and a loop that cannot run says why instead
of failing the run.
"""

from __future__ import annotations

import asyncio
import base64
import os
import re
import tempfile
from collections.abc import Awaitable, Callable
from dataclasses import replace
from pathlib import Path
from typing import Any

import httpx
from design_to_code.budget import FLAT_RATE, PRICED, Pricing, Usage
from design_to_code.diff import (
    JPEG_TOLERANCE,
    Box,
    Region,
    band_regions,
    compare,
    fraction_box,
    load_image,
)
from design_to_code.loop import (
    CorrectionError,
    LoopConfig,
    LoopOutcome,
    Reply,
    run_loop,
    serialize,
)
from design_to_code.pass_fix import fix_from_passes
from design_to_code.passes import responsive_pass, states_pass
from design_to_code.preview import PREVIEW_PATH, extract_html, html_page, mirror_prompt
from design_to_code.render import Renderer, RenderError, font_families
from design_to_code.vision import (
    LOCAL_ROUTES,
    Credentials,
    VisionRoute,
    catalogue_provider,
    decide_route,
)
from PIL import UnidentifiedImageError
from services.design_to_code_edit_calls import (
    EDITS_SCHEMA,
    SCHEMA_ROUTES,
    ask_claude_for_edits,
)
from services.design_to_code_stacks import get_stack

#: Component types whose pixels never match a generated placeholder, or change
#: between two captures: left out of the score.
DYNAMIC_TYPES = frozenset(
    {
        "image",
        "img",
        "photo",
        "picture",
        "illustration",
        "avatar",
        "video",
        "map",
        "chart",
        "graph",
        "carousel",
        "media",
        "date",
        "time",
        "clock",
        "timestamp",
        "ad",
    }
)
#: What a provider's failure says on the page: its kind, never its text (an
#: HTTP error carries the request URL, and Gemini's carries its key).
_PROVIDER_ERRORS = (
    httpx.HTTPError,
    RuntimeError,
    ValueError,
    KeyError,
    IndexError,
    TypeError,
    OSError,
)

Progress = Callable[[dict], None]


def skipped(
    reason: str, *, threshold: float, route: VisionRoute | None = None, detail: str = ""
) -> dict:
    """The report of a loop that did not run, and why (a code the page translates)."""
    return {
        "status": "skipped",
        "reason": reason,
        "detail": detail,
        "provider": route.provider if route else "",
        "model": route.model if route else "",
        "threshold": threshold,
        "mirror": False,
        "best_iteration": 0,
        "iterations": [],
        "issues": [],
    }


def decode_target(image_data: str) -> tuple[bytes, str] | None:
    """(bytes, mime) of a data URL or bare base64, or None for an SVG or garbage."""
    mime = "image/png"
    payload = image_data
    if image_data.startswith("data:"):
        header, _, payload = image_data.partition(",")
        mime = header[5:].split(";")[0].lower() or mime
    if "svg" in mime:
        return None
    try:
        return base64.b64decode(payload, validate=False), mime
    except ValueError:
        return None


def _clean_name(name: str, index: int) -> str:
    """A region's name from the vision step, reduced to a label (it came from a picture)."""
    cleaned = re.sub(r"[^\w .-]", "", str(name or ""))[:40].strip()
    return cleaned or f"zone {index + 1}"


def layout(
    spec: Any, width: int, height: int
) -> tuple[list[Region], list[Box], list[str]]:
    """(regions to compare, masked boxes, masked region names) from the spec."""
    regions: list[Region] = []
    masks: list[Box] = []
    masked: list[str] = []
    for index, component in enumerate(getattr(spec, "components", None) or []):
        bounds = component.bounds
        box = fraction_box(bounds, width, height) if bounds else None
        if box is None:
            continue
        name = _clean_name(component.name, index)
        if str(component.type).strip().lower() in DYNAMIC_TYPES:
            masks.append(box)
            masked.append(name)
        else:
            regions.append(Region(name, box))
    return regions or band_regions(width, height), masks, masked


def drawn_masks(
    boxes: tuple[tuple[float, float, float, float], ...], width: int, height: int
) -> list[Box]:
    """The zones the person drew on the design (fractions), in pixels."""
    found: list[Box] = []
    for x, y, w, h in boxes:
        box = fraction_box({"x": x, "y": y, "w": w, "h": h}, width, height)
        if box is not None:
            found.append(box)
    return found


def credentials() -> Credentials:
    from services.design_to_code_service import _claude_signed_in

    return Credentials(
        anthropic_key=bool(os.getenv("ANTHROPIC_API_KEY")),
        openai_key=bool(os.getenv("OPENAI_API_KEY")),
        google_key=bool(os.getenv("GOOGLE_API_KEY") or os.getenv("GEMINI_API_KEY")),
        claude_signed_in=_claude_signed_in(),
    )


def local_vision_model() -> str:
    """The local vision model: docintel's setting, then the local model chosen."""
    from docintel.settings import DEFAULT_VISION_MODEL, VISION_MODEL_ENV

    for name in (VISION_MODEL_ENV, "OLLAMA_MODEL", "LOCAL_LLM_MODEL"):
        value = (os.getenv(name) or "").strip()
        if value:
            return value
    return DEFAULT_VISION_MODEL


def route_models(service: Any) -> dict[str, str]:
    """The model each route would ask, so the catalogue can be consulted."""
    from core.oneshot import _resolve_model
    from services.design_to_code_service import (
        GOOGLE_VISION_MODEL,
        OPENAI_VISION_MODEL,
    )

    subscription = _resolve_model("claude", None, None)
    return {
        "claude_api": service.vision_model,
        "claude_subscription": service.vision_model
        if subscription == "default"
        else subscription,
        "openai": OPENAI_VISION_MODEL,
        "google": os.getenv("DESIGN_TO_CODE_VISION_MODEL_GOOGLE", GOOGLE_VISION_MODEL),
        "ollama": local_vision_model(),
        "lm-studio": _resolve_model("lm-studio", None, None),
        "llama-cpp": _resolve_model("llama-cpp", None, None),
    }


def pricing_for(route: VisionRoute) -> Pricing:
    """How the route's tokens are paid, from the price catalogue only.

    The subscription and a local model have no per-token price (``flat_rate``);
    a model the catalogue does not price is ``unknown``, never guessed.
    """
    from cost_intelligence.catalog import FLAT_RATE_PROVIDERS, PricingCatalog

    provider = catalogue_provider(route.route)
    if (
        route.route == "claude_subscription"
        or route.route in LOCAL_ROUTES
        or provider in FLAT_RATE_PROVIDERS
    ):
        return Pricing(FLAT_RATE, lambda usage: 0.0)
    row = PricingCatalog().get_pricing(provider, route.model) if route.model else None
    if row is None:
        return Pricing()

    def price(usage: Usage) -> float:
        return row.cost_for_tokens(
            input_tokens=usage.input_tokens,
            output_tokens=usage.output_tokens,
            cache_write_tokens=usage.cache_write_tokens,
            cache_read_tokens=usage.cache_read_tokens,
        )

    return Pricing(PRICED, price)


def make_corrector(service: Any, route: VisionRoute) -> Callable[[str, bytes], Any]:
    """The loop's ``correct``: the composite picture and the prompt to one vision
    call, answered with the tokens the provider reported (``service.last_usage``)."""

    forced = route.route in SCHEMA_ROUTES

    async def ask_local(prompt: str, png: bytes) -> str:
        from docintel.engines.ollama_vision import ask
        from docintel.settings import VISION_MODEL_ENV

        with tempfile.TemporaryDirectory(prefix="wp-design-loop-") as folder:
            image = Path(folder) / "compare.png"
            image.write_bytes(png)
            env = {**os.environ, VISION_MODEL_ENV: route.model}
            text, reason = await asyncio.to_thread(
                ask, image, prompt, env, schema=EDITS_SCHEMA if forced else None
            )
        if not text:
            raise CorrectionError(f"local vision model: {reason}")
        return text

    async def correct(prompt: str, png: bytes) -> Reply:
        service.last_usage = None
        if route.route == "ollama":
            return Reply(await ask_local(prompt, png))
        return await ask_model(prompt, png)

    async def ask_model(prompt: str, png: bytes) -> Reply:
        data_url = "data:image/png;base64," + base64.b64encode(png).decode("ascii")
        try:
            if route.route == "claude_subscription":
                answer = await ask_claude_for_edits(
                    route.model, prompt, png, project_path=service.project_path
                )
                return Reply(answer.text, answer.usage)
            return Reply(await ask_service(data_url, prompt), service.last_usage)
        except httpx.HTTPStatusError as exc:
            raise CorrectionError(
                f"provider answered HTTP {exc.response.status_code}"
            ) from exc
        except _PROVIDER_ERRORS as exc:
            raise CorrectionError(
                f"provider call failed ({type(exc).__name__})"
            ) from exc

    async def ask_service(data_url: str, prompt: str) -> str:
        if route.route == "claude_api":
            return await service._call_claude_vision(
                os.environ["ANTHROPIC_API_KEY"], data_url, prompt, forced=forced
            )
        if route.route == "openai":
            return await service._call_openai_vision(
                os.environ["OPENAI_API_KEY"], data_url, prompt, forced=forced
            )
        if route.route in LOCAL_ROUTES:
            return await service._call_local_vision(
                route.route, data_url, prompt, forced=forced
            )
        key = os.getenv("GOOGLE_API_KEY") or os.environ["GEMINI_API_KEY"]
        return await service._call_gemini_vision(key, data_url, prompt, forced=forced)

    return correct


async def _mirror(
    service: Any, files: dict[str, str], stack_label: str, size: tuple[int, int]
) -> str | None:
    from core.oneshot import oneshot_completion

    prompt = mirror_prompt(
        files, stack_label=stack_label, width=size[0], height=size[1]
    )
    return extract_html(
        await oneshot_completion(prompt, project_dir=str(service.project_path))
    )


def local_unavailable(route: VisionRoute) -> str:
    """Why the route's local model cannot answer ("" when it can, or is not local).

    Ollama is asked by ``docintel``'s engine; LM Studio and llama.cpp must have
    a loopback endpoint (``offline_policy.local_endpoint``), and a server that
    is not running fails the first correction instead.
    """
    if route.route == "ollama":
        from docintel.engines.ollama_vision import OllamaVisionEngine
        from docintel.settings import VISION_MODEL_ENV

        return (
            OllamaVisionEngine().available(
                {**os.environ, VISION_MODEL_ENV: route.model}
            )
            or ""
        )
    if route.route in LOCAL_ROUTES:
        from offline_policy import local_endpoint

        try:
            local_endpoint(route.route)
        except ValueError:
            return "endpoint_not_loopback"
    return ""


def active_provider() -> str:
    """The page's provider, read without side effect (``peek_active_provider``)."""
    from core.client import peek_active_provider

    return (peek_active_provider() or "").strip().lower()


def airgap_strict(project_path: Path) -> bool:
    from offline_policy import airgap_status

    return bool(airgap_status(project_path).get("airgapStrict"))


async def run_render_loop(
    service: Any,
    result: Any,
    *,
    image_data: str,
    framework: str,
    config: LoopConfig,
    on_progress: Progress | None = None,
) -> dict:
    """Refine ``result.generated_files`` in place; return the loop's report."""
    threshold = config.threshold
    if result.simulated:
        return skipped("no_model", threshold=threshold)
    if not result.generated_files:
        return skipped("no_files", threshold=threshold)
    decoded = decode_target(image_data)
    try:
        target = load_image(decoded[0]) if decoded else None
    except (UnidentifiedImageError, OSError, ValueError):
        target = None
    if decoded is None or target is None:
        return skipped("unsupported_target", threshold=threshold)

    route = decide_route(
        active_provider(),
        airgap_strict=airgap_strict(service.project_path),
        credentials=credentials(),
        models=route_models(service),
    )
    if route.refusal:
        return skipped(route.refusal, threshold=threshold, route=route)
    reason = local_unavailable(route)
    if reason:
        return skipped(
            "local_unavailable", threshold=threshold, route=route, detail=reason
        )

    stack = get_stack(framework)
    files = {f.path: f.content for f in result.generated_files}
    page = html_page(files) if stack.id == "html" else None
    mirror = page is None
    if page is None:
        preview = await _mirror(service, files, stack.label, target.size)
        if not preview:
            return skipped("no_preview", threshold=threshold, route=route)
        files[PREVIEW_PATH] = preview
        page = PREVIEW_PATH
    entry: str = page

    if decoded[1] in ("image/jpeg", "image/jpg"):
        config.tolerance = max(config.tolerance, JPEG_TOLERANCE)
    regions, masks, masked = layout(result.design_spec, *target.size)
    drawn = drawn_masks(config.masks, *target.size)
    masks = masks + drawn
    fonts = font_families(getattr(result.design_spec, "typography", None))
    from verify.devtools import chrome_executable

    renderer = Renderer(*target.size, executable=chrome_executable())
    try:
        async with renderer:

            async def render(version: dict[str, str]):
                return load_image(await renderer.capture(version, entry, fonts))

            correct = make_corrector(service, route)
            outcome = await run_loop(
                target,
                files,
                render=render,
                correct=correct,
                regions=regions,
                masks=masks,
                stack_label=stack.label,
                mirror=mirror,
                config=config,
                on_progress=on_progress,
                pricing=pricing_for(route),
            )
            passes = await run_passes(
                renderer,
                outcome,
                entry,
                target=target,
                regions=regions,
                masks=masks,
                config=config,
                on_progress=on_progress,
            )
            if config.fix_passes:
                fixed = await run_pass_fix(
                    outcome,
                    passes,
                    render=render,
                    rerun=lambda version: run_passes(
                        renderer,
                        replace(outcome, files=version),
                        entry,
                        target=target,
                        regions=regions,
                        masks=masks,
                        config=config,
                        on_progress=None,
                    ),
                    target=target,
                    regions=regions,
                    masks=masks,
                    correct=correct,
                    config=config,
                    stack_label=stack.label,
                    mirror=mirror,
                    on_progress=on_progress,
                )
                passes = {**passes, **fixed}
    except RenderError as exc:
        return skipped(exc.code, threshold=threshold, route=route)

    for generated in result.generated_files:
        generated.content = outcome.files.get(generated.path, generated.content)
    width, height, scale = renderer.viewport
    return serialize(
        outcome,
        threshold=threshold,
        mirror=mirror,
        extra={
            "provider": route.provider,
            "route": route.route,
            "model": route.model,
            "masked": masked,
            "drawn_masks": len(drawn),
            "missing_fonts": renderer.missing_fonts,
            "viewport": {"width": width, "height": height, "scale": scale},
            "tolerance": config.tolerance,
            **passes,
        },
    )


async def run_passes(
    renderer: Renderer,
    outcome: Any,
    entry: str,
    *,
    target: Any,
    regions: list[Region],
    masks: list[Box],
    config: LoopConfig,
    on_progress: Progress | None,
) -> dict:
    """The responsive and states passes asked for, on the version kept.

    A pass that cannot open the page reports why; the loop's result stays.
    """
    found: dict[str, dict] = {}
    if not outcome.iterations:
        return found
    asked = [name for name in ("responsive", "states") if getattr(config, name)]
    for name in asked:
        if on_progress is not None:
            on_progress(
                {
                    "stage": name,
                    "iteration": outcome.best_index,
                    "max_iterations": config.max_iterations,
                    "score": None,
                    "best": outcome.iterations[outcome.best_index].score,
                }
            )
        try:
            if name == "responsive":
                found[name] = await responsive_pass(
                    renderer,
                    outcome.files,
                    entry,
                    target=target,
                    regions=regions,
                    masks=masks,
                    tolerance=config.tolerance,
                    threshold=config.threshold,
                )
            else:
                found[name] = await states_pass(renderer, outcome.files, entry)
        except RenderError as exc:
            found[name] = {"status": "failed", "detail": exc.code}
    return found


async def run_pass_fix(
    outcome: LoopOutcome,
    passes: dict,
    *,
    render: Callable[[dict[str, str]], Awaitable[Any]],
    rerun: Callable[[dict[str, str]], Awaitable[dict]],
    target: Any,
    regions: list[Region],
    masks: list[Box],
    correct: Callable[[str, bytes], Any],
    config: LoopConfig,
    stack_label: str,
    mirror: bool,
    on_progress: Progress | None,
) -> dict:
    """One correction from what the passes found (``design_to_code.pass_fix``).

    A kept correction replaces the files and the passes of the outcome; the
    spend then counts it. Returns what goes into the report.
    """
    if not outcome.iterations or not passes or outcome.ledger is None:
        return {}
    best = outcome.iterations[outcome.best_index]
    if on_progress is not None:
        on_progress(
            {
                "stage": "fix_passes",
                "iteration": outcome.best_index,
                "max_iterations": config.max_iterations,
                "score": None,
                "best": best.score,
            }
        )

    async def score(version: dict[str, str]) -> float:
        report = compare(
            target,
            await render(version),
            regions,
            masks=masks,
            tolerance=config.tolerance,
            threshold=config.threshold,
        )
        return report.score

    fix = await fix_from_passes(
        outcome.files,
        passes,
        render_png=best.render_png,
        best_score=best.score,
        correct=correct,
        score=score,
        rerun=rerun,
        spend=outcome.ledger,
        max_tokens=config.max_tokens,
        max_cost_usd=config.max_cost_usd,
        min_gain=config.min_gain,
        stack_label=stack_label,
        mirror=mirror,
    )
    outcome.spend = outcome.ledger.as_dict(config.max_tokens, config.max_cost_usd)
    found: dict = {"pass_fix": fix.report}
    if fix.files is not None:
        outcome.files = fix.files
        found.update(fix.passes or {})
    return found

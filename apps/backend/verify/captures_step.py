"""The verification's captures, protected and paired for the pull request.

Three things the verification does for `pr_captures`, which takes no capture
itself:

- **a protected screenshot** (`protected_screenshot`): before the browser
  takes a screenshot, the personal values on the page are swapped for fakes
  of the same kind (`pr_captures.privacy`), and put back right after, so the
  rest of the scenario runs on the real page. What reaches the disk never
  held the real values. A note beside the image says the page was checked.
- **the base side's screens** (`capture_side`): the comparison with the base
  branch replays the scenario; it now also opens each page the verification
  captured, at the same width, and files both sides under
  `<spec>/captures/{base,task}/`, where they pair as "before" and "after".
- **the step after the loop** (`after_verify`): decide whether the task needs
  captures (its changed files touch a screen, or the team said so), run the
  comparison when it does, and prepare `captures/publication.json`.

None of it changes the verification's verdict, and none of it raises.
"""

from __future__ import annotations

import asyncio
import logging
import shutil
from collections.abc import Callable
from pathlib import Path
from urllib.parse import urlsplit

logger = logging.getLogger(__name__)

__all__ = ["after_verify", "capture_side", "protected_screenshot"]


def _key_dir(spec_dir: Path | None, base: Path) -> Path:
    from docintel.visual_qa import CAPTURES_DIR

    return (spec_dir / CAPTURES_DIR) if spec_dir is not None else base


async def protected_screenshot(
    browser,
    path: Path,
    *,
    project_dir: Path,
    spec_dir: Path | None,
    base: Path,
    full_page: bool = False,
) -> bool:
    """Take a screenshot with the page's personal data swapped for fakes."""
    from pr_captures.fakes import load_key
    from pr_captures.privacy import (
        PageCheck,
        apply_script,
        collect_script,
        page_mapping,
        restore_script,
        write_page_check,
    )
    from pr_captures.settings import load_settings as capture_settings

    settings = capture_settings(project_dir)
    check: PageCheck | None = None
    swapped = False
    if settings.mask:
        try:
            answer = await browser.evaluate(collect_script(settings.mask_selectors))
            found = page_mapping(answer, load_key(_key_dir(spec_dir, base)))
            if found is not None:
                mapping, kinds = found
                check = PageCheck(len(mapping), kinds, sorted(set(mapping.values())))
                if mapping:
                    await browser.evaluate(apply_script(mapping))
                    swapped = True
        except Exception as exc:  # noqa: BLE001 - the capture is then OCR's to check
            logger.debug("verify: page pseudonyms skipped: %s", exc)
            check = None
    try:
        ok = await browser.screenshot(path, full_page=full_page)
    finally:
        if swapped:
            try:
                await browser.evaluate(restore_script())
            except Exception as exc:  # noqa: BLE001
                logger.debug("verify: page pseudonyms not restored: %s", exc)
    if ok and check is not None:
        write_page_check(path, check)
    return ok


def file_with_check(
    spec_dir: Path,
    path: Path,
    *,
    side: str,
    platform: str,
    url: str,
    label: str,
    variant: str = "",
) -> bool:
    """File ``path`` in the captures store, its page check beside it."""
    from docintel.visual_qa import save_capture
    from pr_captures.privacy import SIDECAR_SUFFIX

    saved = save_capture(
        spec_dir,
        path.read_bytes(),
        side=side,
        platform=platform,
        source="verifier",
        url=url,
        label=label,
        variant=variant,
    )
    if saved.status != "saved":
        return False
    sidecar = path.with_name(path.name + SIDECAR_SUFFIX)
    filed = spec_dir / saved.path
    target = filed.with_name(filed.name + SIDECAR_SUFFIX)
    try:
        if sidecar.is_file():
            shutil.copyfile(sidecar, target)
        else:
            target.unlink(missing_ok=True)
    except OSError:
        target.unlink(missing_ok=True)
    return True


def _screens(record: dict) -> list[dict]:
    """The pages the verification captured: one per (path, variant)."""
    seen: set[tuple[str, str]] = set()
    screens: list[dict] = []
    for shot in record.get("screenshots") or []:
        url = str(shot.get("url") or "")
        if shot.get("compare") or shot.get("platform") not in ("web", "desktop"):
            continue
        parts = urlsplit(url)
        if parts.scheme not in ("http", "https"):
            continue
        variant = "mobile" if shot.get("variant") == "mobile" else ""
        where = parts.path or "/"
        if parts.query:
            where += f"?{parts.query}"
        if (where, variant) in seen:
            continue
        seen.add((where, variant))
        screens.append(
            {
                "path": where,
                "variant": variant,
                "label": str(shot.get("label") or "")[:120],
                "target": str(shot.get("target") or ""),
                "platform": shot.get("platform"),
            }
        )
    return screens[:12]


async def capture_side(
    toolbox, record: dict, side: str, spec_dir: Path, shots: Path
) -> int:
    """Open each captured page on this side's app and file it. Returns the count."""
    filed = 0
    for screen in _screens(record):
        target = toolbox.target(screen["target"] or None, ("web-frontend", "desktop"))
        origin = toolbox.url_of(target)
        if target is None or not origin:
            continue
        browser = await toolbox.browser(target)
        if not browser.available:
            continue
        parts = urlsplit(origin)
        url = f"{parts.scheme}://{parts.netloc}{screen['path']}"
        await browser.navigate(url)
        mobile = screen["variant"] == "mobile" and target.kind != "desktop"
        if mobile:
            await browser.emulate("mobile")
        name = f"{side}-{filed}{'-mobile' if mobile else ''}.png"
        try:
            ok = await protected_screenshot(
                browser,
                shots / name,
                project_dir=toolbox.project_dir,
                spec_dir=spec_dir,
                base=toolbox.base,
            )
        finally:
            if mobile:
                await browser.emulate("desktop")
        if ok and file_with_check(
            spec_dir,
            shots / name,
            side=side,
            platform="desktop" if target.kind == "desktop" else "web",
            url=url,
            label=screen["label"],
            variant=screen["variant"] if mobile else "",
        ):
            filed += 1
    return filed


def _docintel_env(project: Path) -> dict[str, str]:
    from docintel.settings import project_env

    return project_env(project)


async def after_verify(
    project_dir: Path | str,
    spec_dir: Path | str | None,
    record: dict,
    changed_files: list[str] | None,
    *,
    log: Callable[[str], None] = lambda _m: None,
    compare=None,
) -> dict | None:
    """Decide, compare when needed, and prepare the publication. Never raises."""
    if spec_dir is None:
        return None
    project = Path(project_dir).resolve()
    spec = Path(spec_dir).resolve()
    try:
        from pr_captures.decide import decide
        from pr_captures.publication import build_publication
        from pr_captures.settings import load_settings as capture_settings

        settings = capture_settings(project)
        decision = decide(settings, changed_files)
        if (
            decision.needed
            and settings.compare
            and record.get("status") in ("pass", "fail")
        ):
            from .compare import run_base_comparison

            log("verify: captures of the base branch, for the pull request")
            try:
                await (compare or run_base_comparison)(project, spec)
            except Exception as exc:  # noqa: BLE001 - a missing "before" is not a failure
                logger.debug("verify: base captures skipped: %s", exc)
        return await asyncio.to_thread(
            build_publication,
            spec,
            decision=decision,
            settings=settings,
            env=_docintel_env(project),
            policy_paths=(spec, project),
        )
    except Exception as exc:  # noqa: BLE001 - captures never fail a build
        logger.warning("verify: captures for the pull request skipped: %s", exc)
        return None

"""The captures a task will show in its pull request, ready to publish.

The captures themselves already have one home, shared by every reader:
`<spec_dir>/captures/{base,task}/` and its `manifest.json` (`docintel.visual_qa`).
The verification files its screens there as ``task``, the comparison with the
base branch as ``base``, a phone frame and the Kanban's capture button too.
This module does not take a capture; it reads that store and prepares what may
leave the machine:

- base and task captures of the same screen are paired (`Capture.key`):
  "before" and "after";
- each image is copied to `captures/published/<side>/` with its personal data
  replaced by fakes (`privacy.protect_capture`); the original is not touched;
- `captures/publication.json` lists the pairs, what was checked on each image,
  and why a capture is held back (never a value, only kinds and counts).

The pull request step (lot 2) and the app read `publication.json`; neither
reads an original. A capture whose copy is not checked is listed with
``publishable: false`` and stays on the task.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from docintel.visual_qa import CAPTURES_DIR, Capture, spec_captures

from .decide import CaptureDecision
from .fakes import load_key
from .privacy import local_ocr_env, protect_capture
from .settings import CaptureSettings

__all__ = [
    "PUBLICATION_FILE",
    "PUBLISHED_DIR",
    "build_publication",
    "load_publication",
]

logger = logging.getLogger(__name__)

PUBLICATION_FILE = "publication.json"
PUBLISHED_DIR = "published"
VERSION = 1
#: Screens in one pull request at most: a review reads a handful of pairs, not
#: the whole scenario. The task's captures in the app are not limited by it.
MAX_ITEMS = 12

_ORDER = {"web": 0, "desktop": 1, "android": 2, "ios": 3}


@dataclass(frozen=True)
class _Pair:
    key: str
    task: Capture
    base: Capture | None


def _signature(path: Path) -> str:
    try:
        stat = path.stat()
    except OSError:
        return ""
    return f"{stat.st_size}:{stat.st_mtime_ns}"


def load_publication(spec_dir: Path | str) -> dict | None:
    """The last `publication.json` of a task, or None."""
    try:
        data = json.loads(
            (Path(spec_dir) / CAPTURES_DIR / PUBLICATION_FILE).read_text(
                encoding="utf-8"
            )
        )
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) and data.get("version") == VERSION else None


def _pairs(spec_dir: Path) -> list[_Pair]:
    by_key: dict[str, dict[str, Capture]] = {}
    for capture in spec_captures(spec_dir):
        by_key.setdefault(capture.key, {})[capture.side] = capture
    pairs = [
        _Pair(key, sides["task"], sides.get("base"))
        for key, sides in by_key.items()
        if "task" in sides
    ]
    # Desktop web first, its phone view next, then the other platforms.
    pairs.sort(
        key=lambda p: (_ORDER.get(p.task.platform, 9), p.task.route, p.task.variant)
    )
    return pairs[:MAX_ITEMS]


def _side(
    capture: Capture,
    spec_dir: Path,
    previous: dict[str, dict],
    *,
    key: bytes,
    env: dict[str, str],
    policy_paths: tuple[Path, ...],
    settings: CaptureSettings,
) -> dict:
    source = spec_dir / capture.path
    published = (
        Path(CAPTURES_DIR)
        / PUBLISHED_DIR
        / capture.side
        / f"{Path(capture.path).stem}.png"
    )
    signature = _signature(source)
    earlier = previous.get(capture.path)
    if (
        earlier
        and earlier.get("signature") == signature
        and earlier.get("protected") == settings.mask
        and (spec_dir / published).is_file()
    ):
        return earlier
    result = protect_capture(
        source,
        spec_dir / published,
        key=key,
        env=env,
        policy_paths=policy_paths,
        enabled=settings.mask,
    )
    publishable = result.checked or (
        result.status == "unchecked" and settings.publish_unchecked
    )
    if result.status == "unchecked" and publishable:
        # The team chose to publish captures no pass could check: the copy is
        # the image re-encoded, nothing replaced.
        protect_capture(source, spec_dir / published, key=key, env=env, enabled=False)
    elif not publishable:
        (spec_dir / published).unlink(missing_ok=True)
    return {
        "source": capture.path,
        "file": published.as_posix() if publishable else "",
        "signature": signature,
        "protected": settings.mask,
        "privacy": result.to_dict(),
        "publishable": publishable,
    }


def _previous_sides(spec_dir: Path) -> dict[str, dict]:
    earlier = load_publication(spec_dir) or {}
    sides: dict[str, dict] = {}
    for item in earlier.get("items") or []:
        if not isinstance(item, dict):
            continue
        for name in ("before", "after"):
            side = item.get(name)
            if isinstance(side, dict) and isinstance(side.get("source"), str):
                sides[side["source"]] = side
    return sides


def _write(spec_dir: Path, payload: dict) -> None:
    target = spec_dir / CAPTURES_DIR / PUBLICATION_FILE
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_name(f".{target.name}.partial")
    partial.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    os.replace(partial, target)


def build_publication(
    spec_dir: Path | str,
    *,
    decision: CaptureDecision,
    settings: CaptureSettings,
    env: dict[str, str] | None = None,
    policy_paths: tuple[Path, ...] = (),
) -> dict:
    """Prepare the task's publishable captures and write `publication.json`.

    Never raises: a capture that cannot be prepared is listed as not
    publishable, with its reason.
    """
    spec = Path(spec_dir)
    payload: dict = {
        "version": VERSION,
        "generatedAt": datetime.now(UTC).isoformat(timespec="seconds"),
        "decision": decision.to_dict(),
        "settings": {
            "publish": settings.publish,
            "protect": settings.mask,
            "publishUnchecked": settings.publish_unchecked,
        },
        "items": [],
    }
    if decision.needed:
        ocr_env = local_ocr_env(dict(env or {}))
        key = load_key(spec / CAPTURES_DIR)
        previous = _previous_sides(spec)
        options = {
            "key": key,
            "env": ocr_env,
            "policy_paths": policy_paths,
            "settings": settings,
        }
        for pair in _pairs(spec):
            try:
                after = _side(pair.task, spec, previous, **options)
                before = (
                    _side(pair.base, spec, previous, **options)
                    if pair.base is not None
                    else None
                )
            except OSError as exc:
                logger.debug("pr_captures: %s skipped: %s", pair.key, exc)
                continue
            payload["items"].append(
                {
                    "key": pair.key,
                    "label": pair.task.label,
                    "platform": pair.task.platform,
                    "variant": pair.task.variant,
                    "route": pair.task.route,
                    "locale": pair.task.locale,
                    "source": pair.task.source,
                    "before": before,
                    "after": after,
                    "publishable": bool(after.get("publishable")),
                }
            )
    payload["publishable"] = sum(1 for i in payload["items"] if i["publishable"])
    payload["withheld"] = len(payload["items"]) - payload["publishable"]
    try:
        _write(spec, payload)
    except OSError as exc:
        logger.debug("pr_captures: could not write the publication: %s", exc)
    return payload

"""The task's context policy, read from ``task_metadata.json``.

Shape (written by the frontend, camelCase like the rest of the file)::

    "contextPolicy": {"mode": "auto", "thresholdPct": 50, "prepareHandoff": true}

The file is re-read whenever it changes (mtime cache), so a policy edited from
the task panel while the build runs applies at the next check, without a
restart. Absent or invalid values fall back to the defaults below.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

MODES = ("auto", "compact", "clear", "off")
DEFAULT_THRESHOLD_PCT = 50
MIN_THRESHOLD_PCT = 30
MAX_THRESHOLD_PCT = 90
# Above the soft threshold the action waits for a safe point and, ideally, for
# the handoff prepared in the background. Past this one it is applied at the
# very next safe point with whatever handoff exists.
HARD_THRESHOLD_MARGIN = 30
HARD_THRESHOLD_CEILING = 85


@dataclass(frozen=True)
class ContextPolicy:
    mode: str = "auto"
    threshold_pct: int = DEFAULT_THRESHOLD_PCT
    prepare_handoff: bool = True

    @property
    def enabled(self) -> bool:
        return self.mode != "off"

    @property
    def hard_threshold_pct(self) -> int:
        return max(
            self.threshold_pct,
            min(self.threshold_pct + HARD_THRESHOLD_MARGIN, HARD_THRESHOLD_CEILING),
        )


DEFAULT_POLICY = ContextPolicy()


def _clamp_threshold(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return DEFAULT_THRESHOLD_PCT
    stepped = int(round(float(value) / 5.0) * 5)
    return max(MIN_THRESHOLD_PCT, min(MAX_THRESHOLD_PCT, stepped))


def policy_from_dict(raw: object) -> ContextPolicy:
    """A policy from the metadata block. Pure; never raises."""
    if not isinstance(raw, dict):
        return DEFAULT_POLICY
    mode = raw.get("mode")
    prepare = raw.get("prepareHandoff")
    return ContextPolicy(
        mode=mode if mode in MODES else DEFAULT_POLICY.mode,
        threshold_pct=_clamp_threshold(raw.get("thresholdPct", DEFAULT_THRESHOLD_PCT)),
        prepare_handoff=prepare if isinstance(prepare, bool) else True,
    )


_cache: dict[Path, tuple[float, ContextPolicy]] = {}


def load_context_policy(spec_dir: Path | str) -> ContextPolicy:
    """The policy in force for the task. Never raises."""
    path = Path(spec_dir) / "task_metadata.json"
    try:
        mtime = path.stat().st_mtime
    except OSError:
        return DEFAULT_POLICY
    cached = _cache.get(path)
    if cached and cached[0] == mtime:
        return cached[1]
    try:
        meta = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return cached[1] if cached else DEFAULT_POLICY
    policy = policy_from_dict(
        meta.get("contextPolicy") if isinstance(meta, dict) else None
    )
    _cache[path] = (mtime, policy)
    return policy

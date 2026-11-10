"""The monthly carbon budget: where the month stands, alerts, degraded mode.

``monthly_budget_kg`` in ``.workpilot/carbon.json`` is the budget of a
calendar month (UTC). The month is ``ok`` under ``alert_percent``, then
``warning``, then ``exceeded`` at 100 %. Each threshold is announced once a
month: ``.workpilot/carbon-budget-state.json`` remembers which ones were.

With ``degrade: true`` and the month exceeded, ``degraded_model`` steps a
flagship model down to its provider's standard one (Opus to Sonnet, a GPT
flagship to its standard model…). Nothing else changes. A standard or fast
model stays as chosen, and a local model too. The phase logs the switch.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from . import config as carbon_config
from .ledger import Row, path_of, raw_entries, rows

logger = logging.getLogger(__name__)


def status(
    all_rows: list[Row], cfg: carbon_config.CarbonConfig, now: datetime | None = None
) -> dict[str, Any]:
    now = now or datetime.now(UTC)
    month = now.strftime("%Y-%m")
    used = sum(r.estimate.co2_g for r in all_rows if r.month == month)
    budget = cfg.monthly_budget_kg * 1000
    percent = round(used / budget * 100, 1) if budget else None
    state = (
        "none"
        if not budget
        else "exceeded"
        if used >= budget
        else "warning"
        if percent >= cfg.alert_percent
        else "ok"
    )
    return {
        "month": month,
        "usedG": used,
        "budgetG": budget,
        "percent": percent,
        "alertPercent": cfg.alert_percent,
        "state": state,
        "degrade": cfg.degrade,
        "degraded": cfg.degrade and state == "exceeded",
    }


def _state_path(root: Path) -> Path | None:
    folder = root / ".workpilot"
    if folder.is_symlink() or not folder.is_dir():
        return None
    path = folder / "carbon-budget-state.json"
    return None if path.is_symlink() else path


def due_alerts(root: Path, current: dict[str, Any]) -> list[int]:
    """The thresholds (alert %, 100) crossed this month and not announced yet; records them."""
    if current["state"] in ("none", "ok"):
        return []
    crossed = [int(current["alertPercent"])]
    if current["state"] == "exceeded":
        crossed.append(100)
    path = _state_path(root)
    if path is None:
        return []
    seen: dict[str, Any] = {}
    if path.is_file():
        try:
            seen = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            seen = {}
    announced = (
        seen.get("announced", []) if seen.get("month") == current["month"] else []
    )
    new = [t for t in crossed if t not in announced]
    if new:
        path.write_text(
            json.dumps(
                {"month": current["month"], "announced": sorted({*announced, *new})}
            ),
            encoding="utf-8",
        )
    return new


def lighter_model(
    model: str, default_of: Callable[[str], str | None] | None = None
) -> str | None:
    """The provider's standard model when ``model`` is a flagship; None otherwise.

    ``default_of(provider)`` gives the provider's own default model when it is
    not a flagship (``phase_config`` passes it); otherwise the registry's first
    standard model of the provider is used.

    A model the registry lists is a flagship by its tier. One it does not list
    (an older id) is a flagship by its name (``factors.model_tier``), and its
    provider is the one whose models share its first word (``claude``, ``gpt``…).
    """
    from models_registry import REGISTRY, get_tier

    from .factors import model_tier

    provider = ""
    for entry in REGISTRY:
        if entry.model_id == model:
            if entry.tier != "flagship":
                return None
            provider = entry.provider
            break
    if not provider:
        if model_tier("", model) != "large":
            return None
        family = model.split("-", 1)[0].lower()
        provider = next(
            (
                e.provider
                for e in REGISTRY
                if e.model_id.split("-", 1)[0].lower() == family
            ),
            "",
        )
    if not provider:
        return None
    lighter = default_of(provider) if default_of else None
    if lighter is None:
        entry = get_tier(provider, "standard")
        lighter = entry.model_id if entry else None
    return lighter if lighter and lighter != model else None


def project_root(spec_dir: Path) -> Path | None:
    """The project that owns ``spec_dir`` (a task worktree's main project, too)."""
    parts = spec_dir.resolve().parts
    for index, part in enumerate(parts):
        if part == ".workpilot" and index:
            return Path(*parts[:index])
    return None


_cache: dict[str, tuple[tuple[str, float, float], bool]] = {}


def _mtime(path: Path | None) -> float:
    try:
        return path.stat().st_mtime if path else 0.0
    except OSError:
        return 0.0


def exceeded_with_degrade(root: Path) -> bool:
    cfg_path = root / ".workpilot" / "carbon.json"
    key = (datetime.now(UTC).strftime("%Y-%m"), _mtime(cfg_path), _mtime(path_of(root)))
    cached = _cache.get(str(root))
    if cached and cached[0] == key:
        return cached[1]
    cfg = carbon_config.load(root)
    answer = False
    if cfg.degrade and cfg.monthly_budget_kg > 0:
        try:
            answer = bool(status(rows(raw_entries(root) or [], cfg), cfg)["degraded"])
        except (OSError, ValueError):
            answer = False
    _cache[str(root)] = (key, answer)
    return answer


def degraded_model(
    spec_dir: Path | None,
    model: str,
    phase: str = "",
    default_of: Callable[[str], str | None] | None = None,
) -> str:
    """``model``, or its lighter tier when the project's carbon budget says so."""
    if not spec_dir or not model:
        return model
    root = project_root(spec_dir)
    if root is None or not exceeded_with_degrade(root):
        return model
    lighter = lighter_model(model, default_of)
    if not lighter:
        return model
    logger.warning(
        "Carbon budget of the month reached: %s runs on %s instead of %s",
        phase or "phase",
        lighter,
        model,
    )
    return lighter


__all__ = ["degraded_model", "due_alerts", "lighter_model", "status"]

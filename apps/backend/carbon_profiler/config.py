"""A project's carbon settings: ``.workpilot/carbon.json``.

```json
{
  "region": "fr",              // the grid of this machine, for local models
  "monthly_budget_kg": 5,      // kg CO₂e per calendar month, 0 = no budget
  "alert_percent": 80,         // first alert
  "degrade": false,            // at 100 %: flagship models step down one tier
  "local_power_w": 150,        // power drawn while a local model answers
  "cpu_only": false,
  "factors": {"grid.fr": 32, "pue.mistral": 1.15, "wh_per_1k_output.large": 2.0}
}
```

The file is WorkPilot's (ignored by git), read without following a link,
16 KB at most; a value out of range falls back to its default.
"""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from .factors import CPU_ONLY_POWER_W, DEFAULT_LOCAL_POWER_W, GRID_INTENSITY

MAX_BYTES = 16 * 1024
_FACTOR = re.compile(
    r"^(grid\.[a-z-]{2,20}|pue\.[a-z.-]{1,30}|wh_per_1k_output\.(small|medium|large)|region\.[a-z.-]{1,30})$"
)


@dataclass
class CarbonConfig:
    region: str = "world"
    monthly_budget_kg: float = 0.0
    alert_percent: int = 80
    degrade: bool = False
    local_power_w: float = DEFAULT_LOCAL_POWER_W
    cpu_only: bool = False
    factors: dict[str, Any] = field(default_factory=dict)

    @property
    def power_w(self) -> float:
        return CPU_ONLY_POWER_W if self.cpu_only else self.local_power_w

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        return {
            "region": data["region"],
            "monthlyBudgetKg": data["monthly_budget_kg"],
            "alertPercent": data["alert_percent"],
            "degrade": data["degrade"],
            "localPowerW": data["local_power_w"],
            "cpuOnly": data["cpu_only"],
            "factors": data["factors"],
            "regions": sorted(GRID_INTENSITY),
        }


def _path(root: Path) -> Path | None:
    folder = root / ".workpilot"
    if folder.is_symlink():
        return None
    path = folder / "carbon.json"
    return None if path.is_symlink() else path


def _number(value: object, low: float, high: float, default: float) -> float:
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not low <= value <= high
    ):
        return default
    return float(value)


def from_dict(raw: object) -> CarbonConfig:
    data = raw if isinstance(raw, dict) else {}
    region = data.get("region")
    factors_raw = data.get("factors")
    factors: dict[str, Any] = {}
    if isinstance(factors_raw, dict):
        for key, value in list(factors_raw.items())[:60]:
            if not isinstance(key, str) or not _FACTOR.match(key):
                continue
            if key.startswith("region."):
                if isinstance(value, str) and value in GRID_INTENSITY:
                    factors[key] = value
            elif (
                not isinstance(value, bool)
                and isinstance(value, (int, float))
                and 0 < value < 5000
            ):
                factors[key] = float(value)
    return CarbonConfig(
        region=region
        if isinstance(region, str) and region in GRID_INTENSITY
        else "world",
        monthly_budget_kg=_number(data.get("monthly_budget_kg"), 0, 1_000_000, 0.0),
        alert_percent=int(_number(data.get("alert_percent"), 10, 99, 80)),
        degrade=data.get("degrade") is True,
        local_power_w=_number(
            data.get("local_power_w"), 1, 5000, DEFAULT_LOCAL_POWER_W
        ),
        cpu_only=data.get("cpu_only") is True,
        factors=factors,
    )


def load(root: Path) -> CarbonConfig:
    path = _path(root)
    if path is None or not path.is_file() or path.stat().st_size > MAX_BYTES:
        return CarbonConfig()
    try:
        return from_dict(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, ValueError):
        return CarbonConfig()


def save(root: Path, raw: object) -> CarbonConfig:
    """Keep the checked form of ``raw`` (camelCase from the page, or snake_case)."""
    data = raw if isinstance(raw, dict) else {}
    names = {
        "monthlyBudgetKg": "monthly_budget_kg",
        "alertPercent": "alert_percent",
        "localPowerW": "local_power_w",
        "cpuOnly": "cpu_only",
    }
    config = from_dict({names.get(k, k): v for k, v in data.items()})
    folder = root / ".workpilot"
    if folder.is_symlink():
        raise ValueError("the .workpilot folder is a link")
    folder.mkdir(exist_ok=True)
    path = _path(root)
    if path is None:
        raise ValueError("carbon.json is a link")
    from foundation.file_utils import atomic_write

    snake = asdict(config)
    with atomic_write(path) as handle:
        json.dump(snake, handle, indent=2)
    return config


__all__ = ["CarbonConfig", "from_dict", "load", "save"]

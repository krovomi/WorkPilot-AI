"""The carbon ledger: one line per model call, ``.workpilot/carbon-ledger.json``.

``core.usage_tracker`` appends each call the agents make (provider, model,
tokens, cache reads, task, phase, agent). This module reads it back, never
through a link and 50 MB at most, and gives each row its estimate
(``factors.estimate``).
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .config import CarbonConfig
from .factors import Estimate, estimate, is_local

MAX_BYTES = 50 * 1024 * 1024


@dataclass
class Row:
    at: datetime | None
    source: str
    provider: str
    model: str
    tokens_in: int
    tokens_out: int
    cache_read: int
    duration_s: float
    task: str
    phase: str
    agent: str
    estimate: Estimate

    @property
    def month(self) -> str:
        return self.at.strftime("%Y-%m") if self.at else ""

    def to_dict(self) -> dict[str, Any]:
        e = self.estimate
        return {
            "timestamp": self.at.isoformat() if self.at else "",
            "source": self.source,
            "provider": self.provider,
            "model": self.model,
            "tokensIn": self.tokens_in,
            "tokensOut": self.tokens_out,
            "cacheRead": self.cache_read,
            "durationS": self.duration_s,
            "task": self.task,
            "phase": self.phase,
            "agent": self.agent,
            "kwh": e.kwh,
            "co2G": e.co2_g,
            "tier": e.tier,
            "region": e.region,
            "method": e.method,
            "estimated": True,
            "hostKnown": e.host_known,
        }


def path_of(root: Path) -> Path | None:
    folder = root / ".workpilot"
    if folder.is_symlink():
        return None
    path = folder / "carbon-ledger.json"
    return None if path.is_symlink() else path


def raw_entries(root: Path) -> list[dict[str, Any]] | None:
    """The ledger's entries; None when there is no ledger."""
    path = path_of(root)
    if path is None or not path.is_file():
        return None
    if path.stat().st_size > MAX_BYTES:
        raise ValueError("the carbon ledger is over 50 MB")
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise ValueError("the carbon ledger must be a JSON array")
    return [e for e in data if isinstance(e, dict)]


def _int(value: object) -> int:
    try:
        return max(int(value), 0)  # type: ignore[call-overload]
    except (TypeError, ValueError):
        return 0


def _float(value: object) -> float:
    try:
        return max(float(value), 0.0)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 0.0


def _when(value: object) -> datetime | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0:
        return datetime.fromtimestamp(value, tz=UTC)
    if isinstance(value, str) and value:
        try:
            moment = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
        return moment if moment.tzinfo else moment.replace(tzinfo=UTC)
    return None


def _text(value: object, limit: int = 120) -> str:
    return value[:limit] if isinstance(value, str) else ""


def rows(entries: list[dict[str, Any]], config: CarbonConfig) -> list[Row]:
    out: list[Row] = []
    for entry in entries:
        source = _text(entry.get("source")) or "llm_cloud"
        if source not in ("llm_cloud", "llm_local"):
            continue
        provider = _text(entry.get("provider"))
        model = _text(entry.get("model"))
        if is_local(provider):
            source = "llm_local"
        tokens_in, tokens_out = (
            _int(entry.get("tokens_in")),
            _int(entry.get("tokens_out")),
        )
        cache_read = min(_int(entry.get("cache_read")), tokens_in)
        duration = _float(entry.get("duration_s"))
        out.append(
            Row(
                at=_when(entry.get("timestamp")),
                source=source,
                provider=provider,
                model=model,
                tokens_in=tokens_in,
                tokens_out=tokens_out,
                cache_read=cache_read,
                duration_s=duration,
                task=_text(entry.get("task")),
                phase=_text(entry.get("phase"), 60),
                agent=_text(entry.get("agent"), 60),
                estimate=estimate(
                    provider,
                    model,
                    tokens_in=tokens_in,
                    tokens_out=tokens_out,
                    cache_read=cache_read,
                    duration_s=duration,
                    region=config.region,
                    local_power_w=config.power_w,
                    overrides=config.factors,
                ),
            )
        )
    return out


__all__ = ["Row", "path_of", "raw_entries", "rows"]

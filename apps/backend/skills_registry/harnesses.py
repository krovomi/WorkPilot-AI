"""Reading capabilities/harnesses.yaml."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import yaml

__all__ = ["Harness", "load_harnesses", "HARNESSES_RELPATH"]

HARNESSES_RELPATH = Path("capabilities") / "harnesses.yaml"


@dataclass(frozen=True)
class Harness:
    name: str
    skills_path: str | None
    agents_path: str | None
    commands_path: str | None
    format: str
    instruction_file: str | None
    subagents: str
    hooks: str | None
    mcp: str | None
    default: bool
    note: str = ""


def load_harnesses(repo_root: Path) -> dict[str, Harness]:
    path = repo_root / HARNESSES_RELPATH
    if not path.is_file():
        raise FileNotFoundError(f"missing harness matrix: {path}")
    raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    out: dict[str, Harness] = {}
    for name, cfg in raw.items():
        cfg = cfg or {}
        out[name] = Harness(
            name=name,
            skills_path=cfg.get("skills_path"),
            agents_path=cfg.get("agents_path"),
            commands_path=cfg.get("commands_path"),
            format=cfg.get("format", "skill-dir"),
            instruction_file=cfg.get("instruction_file"),
            subagents=cfg.get("subagents", "none"),
            hooks=cfg.get("hooks"),
            mcp=cfg.get("mcp"),
            default=bool(cfg.get("default", False)),
            note=str(cfg.get("note", "") or ""),
        )
    return out

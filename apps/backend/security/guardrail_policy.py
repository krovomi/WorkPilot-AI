"""Where the guardrails come from, layer by layer, and whether they are valid.

Three layers, read in this order (#377):

1. **global**: ``$WORKPILOT_GUARDRAILS_GLOBAL`` or ``~/.workpilot/guardrails.yaml``,
   the person's or the organisation's rules for every project;
2. **repository**: ``workpilot.policy.yaml`` at the root of the repository,
   committed and reviewed like code;
3. **project**: ``.workpilot/guardrails.yaml`` / ``.yml`` / ``.json``, the
   rules edited in Settings > Guardrails (all three are read if present).

A later layer adds rules. It cannot weaken an earlier one: a rule that reuses
an id with a weaker action is dropped with a warning, and since the strictest
triggered rule always wins, an ``allow`` never lifts a ``deny``.

Every file is read from the **main project**, never from the task's worktree:
``.workpilot/`` is git-ignored and absent from a worktree, so the guardrails
used to be skipped for every Kanban build; and the worktree's copy of
``workpilot.policy.yaml`` is the one the agent could edit.
"""

from __future__ import annotations

import json
import os
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from .guardrails import ACTION_PRIORITY, GuardrailRule

GLOBAL_ENV_VAR = "WORKPILOT_GUARDRAILS_GLOBAL"
REPO_POLICY_NAMES = ("workpilot.policy.yaml", "workpilot.policy.yml")
PROJECT_POLICY_NAMES = ("guardrails.yaml", "guardrails.yml", "guardrails.json")
_WORKTREE_MARKERS = (
    (".workpilot", "worktrees"),
    (".workpilot", "github"),  # PR review worktrees: .workpilot/github/pr/worktrees
    (".worktrees",),
)


@dataclass
class PolicySource:
    layer: str  # global | repository | project
    path: str
    rules: int


@dataclass
class Policy:
    rules: list[GuardrailRule] = field(default_factory=list)
    sources: list[PolicySource] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "rules": [
                {
                    "id": r.id,
                    "action": r.action.value,
                    "description": r.description,
                    "source": r.source,
                }
                for r in self.rules
            ],
            "sources": [s.__dict__ for s in self.sources],
            "errors": self.errors,
            "warnings": self.warnings,
        }


def main_project(path: Path) -> Path:
    """The project a path belongs to, out of a task or PR worktree if it is in one."""
    parts = Path(path).parts
    for index in range(len(parts)):
        for marker in _WORKTREE_MARKERS:
            if tuple(parts[index : index + len(marker)]) == marker and index + len(
                marker
            ) < len(parts):
                return Path(*parts[:index])
    return Path(path)


def global_policy_path() -> Path:
    override = os.environ.get(GLOBAL_ENV_VAR, "").strip()
    if override:
        return Path(override).expanduser()
    return Path.home() / ".workpilot" / "guardrails.yaml"


def _parse(path: Path) -> tuple[dict[str, Any] | None, str | None]:
    """The document of ``path``, or the reason it cannot be read."""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        return None, f"{path.name}: cannot be read ({exc.strerror or exc})"
    if not text.strip():
        return {"rules": []}, None
    try:
        if path.suffix == ".json":
            data = json.loads(text)
        else:
            data = yaml.safe_load(text)
    except (ValueError, yaml.YAMLError) as exc:
        return (
            None,
            f"{path.name}: not valid {'JSON' if path.suffix == '.json' else 'YAML'} ({exc})",
        )
    if data is None:
        return {"rules": []}, None
    if not isinstance(data, dict):
        return None, f"{path.name}: the document must be a mapping with a 'rules' list"
    if not isinstance(data.get("rules", []), list):
        return None, f"{path.name}: 'rules' must be a list"
    return data, None


_CACHE: dict[tuple[str, ...], tuple[tuple[float, ...], Policy]] = {}


def _files(project: Path) -> list[tuple[str, Path]]:
    files = [("global", global_policy_path())]
    files += [("repository", project / name) for name in REPO_POLICY_NAMES]
    files += [
        ("project", project / ".workpilot" / name) for name in PROJECT_POLICY_NAMES
    ]
    return [(layer, path) for layer, path in files if path.is_file()]


def load_policy(root: Path) -> Policy:
    """The guardrails for ``root`` (a project or one of its worktrees). Never raises."""
    project = main_project(Path(root))
    files = _files(project)
    key = tuple(str(p) for _, p in files)
    try:
        stamps = tuple(p.stat().st_mtime for _, p in files)
    except OSError:
        stamps = ()
    cached = _CACHE.get(key)
    if cached and cached[0] == stamps:
        return cached[1]

    policy = Policy()
    by_id: dict[str, GuardrailRule] = {}
    for layer, path in files:
        data, error = _parse(path)
        if error:
            policy.errors.append(error)
            continue
        assert data is not None
        rules = [r for r in data.get("rules") or []]
        seen_here: set[str] = set()
        count = 0
        for raw in rules:
            if not isinstance(raw, dict):
                policy.errors.append(f"{path.name}: every rule must be a mapping")
                continue
            rule = GuardrailRule.from_dict(raw, source=f"{layer}:{path.name}")
            policy.errors.extend(f"{path.name}: {e}" for e in rule.errors)
            if rule.errors:
                continue
            if rule.id in seen_here:
                policy.errors.append(f"{path.name}: rule id '{rule.id}' is used twice")
                continue
            seen_here.add(rule.id)
            earlier = by_id.get(rule.id)
            if earlier is not None and earlier.source.split(":")[0] != layer:
                if ACTION_PRIORITY[rule.action] < ACTION_PRIORITY[earlier.action]:
                    policy.warnings.append(
                        f"{path.name}: rule '{rule.id}' cannot weaken the {earlier.source} rule "
                        f"({earlier.action.value} → {rule.action.value}); the stricter one applies"
                    )
                    continue
                rule.id = f"{rule.id}@{layer}"  # both apply, the strictest wins
            by_id[rule.id] = rule
            policy.rules.append(rule)
            count += 1
        policy.sources.append(PolicySource(layer=layer, path=str(path), rules=count))
    if not policy.errors:
        for rule in policy.rules:
            if not rule.tools and not _has_condition(rule):
                policy.warnings.append(
                    f"rule '{rule.id}' has no condition: it applies to every write and command"
                )
    _CACHE[key] = (stamps, policy)
    return policy


def _has_condition(rule: GuardrailRule) -> bool:
    return any(
        (
            rule.path_prefix,
            rule.path_regex,
            rule.path_glob,
            rule.content_regex,
            rule.command_pattern,
            rule.content_max_lines is not None,
            rule.content_max_bytes is not None,
            rule.forbidden_strings,
            rule.new_file_max_lines is not None,
            rule.adds_regex,
            rule.deletes_tests,
            rule.adds_dependency,
            rule.branches,
        )
    )


_BRANCHES: dict[str, tuple[float, str | None]] = {}


def current_branch(root: Path) -> str | None:
    """The branch checked out in ``root``, cached a few seconds."""
    key = str(root)
    cached = _BRANCHES.get(key)
    now = time.monotonic()
    if cached and now - cached[0] < 30:
        return cached[1]
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            cwd=key,
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        branch = result.stdout.strip() if result.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired):
        branch = None
    _BRANCHES[key] = (now, branch or None)
    return branch or None

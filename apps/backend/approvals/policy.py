"""The ``approvals`` section of ``workpilot.policy.yaml``.

.. code-block:: yaml

    approvals:
      mode: observe            # off | observe (default) | enforce
      require_review: true     # N1 merges only after the cross-review agreed
      major_bumps: human       # human (default) | auto
      limits:
        max_files: 20          # an N1 change past these goes to N2
        max_lines: 400
        max_layers: 1
        min_trust: 60          # below this trust score: N2
      sensitive: ["**/payments/**"]   # added to the built-in sensitive paths: N3
      rules:                   # can only make a pull request stricter
        - purpose: "Le module de facturation passe par une personne"
          paths: ["src/Billing/**", "!src/Billing/**/*.md"]
          if: "pr/type != docs"
          tier: human          # review | human | locked (or N1 | N2 | N3)

A section that does not hold is an error list, never a partial policy: the
decision is then LOCKED, so a typo can stop a merge but never allow one.
Unlike the other governance sections, a wrong ``approvals`` section does not
stop the agents: it only decides who merges.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from .conditions import ConditionError, Node, parse_condition
from .model import MODE_OBSERVE, MODES, Tier

SECTION = "approvals"

_KEYS = frozenset(
    {"mode", "require_review", "major_bumps", "limits", "sensitive", "rules"}
)
_LIMIT_KEYS = {
    "max_files": (1, 2_000, 20),
    "max_lines": (1, 100_000, 400),
    "max_layers": (1, 10, 1),
    "min_trust": (0, 100, 60),
}
_RULE_KEYS = frozenset({"purpose", "paths", "if", "tier"})
MAX_RULES = 64
MAX_GLOBS = 200
MAX_RULE_PATHS = 64
MAX_GLOB_CHARS = 256
MAX_PURPOSE_CHARS = 300


@dataclass(frozen=True)
class Rule:
    purpose: str
    include: tuple[str, ...]
    exclude: tuple[str, ...]
    tier: Tier
    condition: Node | None = None
    condition_text: str = ""


@dataclass(frozen=True)
class ApprovalPolicy:
    #: The mode the decision runs in. Parsed from a file: the file's own
    #: ``mode``, ``""`` when it names none; ``load_approval_policy`` then
    #: combines it with the app setting.
    mode: str = MODE_OBSERVE
    require_review: bool = True
    major_bumps: str = "human"
    max_files: int = 20
    max_lines: int = 400
    max_layers: int = 1
    min_trust: int = 60
    sensitive: tuple[str, ...] = ()
    rules: tuple[Rule, ...] = ()
    #: ``files.requires_review`` of the same file: a person approves them, N3.
    requires_review: tuple[str, ...] = ()
    #: Where it was read, for the reasons and the UI.
    source: str = ""
    #: True when the file has an ``approvals`` section (else built-ins only).
    declared: bool = False
    errors: tuple[str, ...] = field(default_factory=tuple)


def _glob(raw: Any, where: str, errors: list[str]) -> str | None:
    text = raw.strip() if isinstance(raw, str) else ""
    normalized = text.replace("\\", "/")
    body = normalized[1:] if normalized.startswith("!") else normalized
    if (
        not body
        or len(text) > MAX_GLOB_CHARS
        or body.startswith("/")
        or re.match(r"^[A-Za-z]:", body)
        or ".." in body.split("/")
        or any(ord(c) < 32 for c in text)
    ):
        errors.append(
            f"{where}: '{str(raw)[:60]}' is not a glob relative to the repository"
        )
        return None
    return normalized.removeprefix("./")


def glob_list(raw: Any, where: str, limit: int, errors: list[str]) -> list[str]:
    if raw is None:
        return []
    if not isinstance(raw, list) or len(raw) > limit:
        errors.append(f"{where} must be a list of at most {limit} globs")
        return []
    return [g for g in (_glob(item, where, errors) for item in raw) if g is not None]


def _rule(raw: Any, index: int, errors: list[str]) -> Rule | None:
    where = f"approvals.rules[{index}]"
    if not isinstance(raw, dict):
        errors.append(f"{where} must be a mapping")
        return None
    for unknown in sorted(set(raw) - _RULE_KEYS):
        errors.append(f"{where}: unknown key '{unknown}'")
    purpose = raw.get("purpose")
    if (
        not isinstance(purpose, str)
        or not purpose.strip()
        or len(purpose) > MAX_PURPOSE_CHARS
    ):
        errors.append(
            f"{where}: 'purpose' is required (at most {MAX_PURPOSE_CHARS} characters)"
        )
        purpose = ""
    globs = glob_list(raw.get("paths"), f"{where}.paths", MAX_RULE_PATHS, errors)
    include = tuple(g for g in globs if not g.startswith("!"))
    exclude = tuple(g[1:] for g in globs if g.startswith("!"))
    if not include:
        errors.append(f"{where}: 'paths' needs at least one pattern without '!'")
    tier_raw = raw.get("tier")
    tier = Tier.from_name(tier_raw) if isinstance(tier_raw, str) else None
    if tier is None:
        errors.append(f"{where}: 'tier' must be review, human or locked")
    elif tier == Tier.AUTO:
        errors.append(
            f"{where}: a rule can only make a pull request stricter; 'auto' lowers nothing"
        )
        tier = None
    condition: Node | None = None
    condition_text = ""
    if "if" in raw:
        condition_text = str(raw.get("if") or "")
        try:
            condition = parse_condition(condition_text)
        except ConditionError as exc:
            errors.append(f"{where}.if: {exc}")
    if tier is None or not include or not purpose:
        return None
    return Rule(
        purpose=purpose.strip(),
        include=include,
        exclude=exclude,
        tier=tier,
        condition=condition,
        condition_text=condition_text,
    )


def parse_approvals(
    data: dict[str, Any] | None,
    *,
    source: str = "",
    requires_review: tuple[str, ...] = (),
) -> ApprovalPolicy:
    """The approval policy of one ``workpilot.policy.yaml`` document.

    ``data`` is the whole document (``None`` when there is no file): without an
    ``approvals`` section the built-in tiers apply in ``observe`` mode.
    """
    raw = (data or {}).get(SECTION)
    if raw is None:
        return ApprovalPolicy(mode="", source=source, requires_review=requires_review)
    errors: list[str] = []
    if not isinstance(raw, dict):
        return ApprovalPolicy(
            source=source,
            declared=True,
            requires_review=requires_review,
            errors=("'approvals' must be a mapping",),
        )
    for unknown in sorted(set(raw) - _KEYS):
        errors.append(f"unknown key 'approvals.{unknown}'")

    # Absent: the file does not restrict the mode the app setting chose.
    mode = raw.get("mode", "")
    if mode != "" and mode not in MODES:
        errors.append(f"'approvals.mode' must be one of {', '.join(MODES)}")
        mode = MODE_OBSERVE
    require_review = raw.get("require_review", True)
    if not isinstance(require_review, bool):
        errors.append("'approvals.require_review' must be true or false")
        require_review = True
    major_bumps = raw.get("major_bumps", "human")
    if major_bumps not in ("human", "auto"):
        errors.append("'approvals.major_bumps' must be human or auto")
        major_bumps = "human"

    limits_raw = raw.get("limits", {})
    if limits_raw is None:
        limits_raw = {}
    limits: dict[str, int] = {}
    if not isinstance(limits_raw, dict):
        errors.append("'approvals.limits' must be a mapping")
        limits_raw = {}
    for unknown in sorted(set(limits_raw) - set(_LIMIT_KEYS)):
        errors.append(f"unknown key 'approvals.limits.{unknown}'")
    for key, (low, high, default) in _LIMIT_KEYS.items():
        value = limits_raw.get(key, default)
        if (
            isinstance(value, bool)
            or not isinstance(value, int)
            or not low <= value <= high
        ):
            errors.append(
                f"'approvals.limits.{key}' must be a whole number from {low} to {high}"
            )
            value = default
        limits[key] = value

    sensitive = glob_list(
        raw.get("sensitive"), "approvals.sensitive", MAX_GLOBS, errors
    )
    if any(g.startswith("!") for g in sensitive):
        errors.append("'approvals.sensitive' takes no '!' pattern: it only adds paths")
    rules_raw = raw.get("rules", [])
    if rules_raw is None:
        rules_raw = []
    rules: list[Rule] = []
    if not isinstance(rules_raw, list) or len(rules_raw) > MAX_RULES:
        errors.append(f"'approvals.rules' must be a list of at most {MAX_RULES} rules")
    else:
        for index, item in enumerate(rules_raw):
            rule = _rule(item, index, errors)
            if rule is not None:
                rules.append(rule)

    return ApprovalPolicy(
        mode=mode,
        require_review=require_review,
        major_bumps=major_bumps,
        max_files=limits["max_files"],
        max_lines=limits["max_lines"],
        max_layers=limits["max_layers"],
        min_trust=limits["min_trust"],
        sensitive=tuple(sensitive),
        rules=tuple(rules),
        requires_review=requires_review,
        source=source,
        declared=True,
        errors=tuple(errors),
    )


__all__ = ["SECTION", "ApprovalPolicy", "Rule", "glob_list", "parse_approvals"]

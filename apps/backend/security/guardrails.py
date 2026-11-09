"""
User-defined Agent Guardrails (policy as code)
==============================================

Lets teams encode their own policies that agents must respect, evaluated on
every Write/Edit/Bash attempt, on every provider (the SDK hook for Claude,
``ToolExecutor`` for the others).

Rules come from three layers (:mod:`security.guardrail_policy`): the user's
global file, ``workpilot.policy.yaml`` committed at the root of the repository,
and ``<project>/.workpilot/guardrails.yaml`` (or ``.yml`` / ``.json``). A later
layer adds rules; it cannot weaken one of an earlier layer. Schema::

    version: 1
    rules:
      - id: no-migrations
        description: Never edit a migration by hand
        when:
          tool: [Write, Edit]
          path_glob: "**/migrations/**"
        action: deny
        message: Use the Database Schema Agent for migrations

      - id: no-test-deletion
        description: Never delete an existing test
        when:
          deletes_tests: true
        action: deny

      - id: dep-review
        description: A new dependency needs a human
        when:
          adds_dependency: true
        action: require_approval

      - id: no-any
        description: No new `any` in TypeScript
        when:
          path_regex: "\\\\.tsx?$"
          adds_regex: ":\\\\s*any\\\\b"
        action: warn

Conditions (all present ones must hold):
  ``tool``, ``path_prefix``, ``path_regex``, ``path_glob``, ``content_regex``,
  ``command_pattern``, ``content_max_lines``, ``content_max_bytes``,
  ``forbidden_strings``, ``new_file_max_lines``, ``adds_regex``,
  ``deletes_tests``, ``adds_dependency``, ``branch``.
  Paths are matched relative to the repository root, whatever the provider
  sent (Claude sends absolute paths).

Actions:
  - ``allow``  — explicit pass (never wins over a stricter rule)
  - ``warn``   — let it through, logged in the activity of Settings > Guardrails
  - ``deny``   — block and surface the rule id/description to the agent
  - ``require_approval`` — block until the person approves that action in
    Settings > Guardrails; the approval lets the next identical call through

An invalid policy (unknown key, bad regex, unknown action) blocks every write
and command until it is fixed: a typo must never turn a rule off in silence.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

WRITE_TOOLS = ("Write", "Edit", "MultiEdit", "NotebookEdit")


class GuardrailAction(str, Enum):
    ALLOW = "allow"
    WARN = "warn"
    DENY = "deny"
    REQUIRE_APPROVAL = "require_approval"


ACTION_PRIORITY = {
    GuardrailAction.ALLOW: 0,
    GuardrailAction.WARN: 1,
    GuardrailAction.REQUIRE_APPROVAL: 2,
    GuardrailAction.DENY: 3,
}

KNOWN_CONDITIONS = frozenset(
    {
        "tool",
        "path_prefix",
        "path_regex",
        "path_glob",
        "content_regex",
        "command_pattern",
        "content_max_lines",
        "content_max_bytes",
        "forbidden_strings",
        "new_file_max_lines",
        "adds_regex",
        "deletes_tests",
        "adds_dependency",
        "branch",
    }
)
_KNOWN_RULE_KEYS = frozenset({"id", "description", "action", "when", "message"})


def glob_to_regex(pattern: str) -> re.Pattern[str]:
    """``**/migrations/**`` style globs: ``**`` crosses folders, ``*`` does not."""
    out = []
    i = 0
    while i < len(pattern):
        if pattern.startswith("**/", i):
            out.append("(?:.*/)?")
            i += 3
        elif pattern.startswith("**", i):
            out.append(".*")
            i += 2
        elif pattern[i] == "*":
            out.append("[^/]*")
            i += 1
        elif pattern[i] == "?":
            out.append("[^/]")
            i += 1
        else:
            out.append(re.escape(pattern[i]))
            i += 1
    return re.compile("^" + "".join(out) + "$")


@dataclass
class GuardrailRule:
    """A single user-defined rule."""

    id: str
    description: str
    action: GuardrailAction
    tools: list[str] = field(default_factory=list)
    path_prefix: str | None = None
    path_regex: re.Pattern[str] | None = None
    path_glob: re.Pattern[str] | None = None
    content_regex: re.Pattern[str] | None = None
    command_pattern: re.Pattern[str] | None = None
    content_max_lines: int | None = None
    content_max_bytes: int | None = None
    forbidden_strings: list[str] = field(default_factory=list)
    new_file_max_lines: int | None = None
    adds_regex: re.Pattern[str] | None = None
    deletes_tests: bool = False
    adds_dependency: bool = False
    branches: list[re.Pattern[str]] = field(default_factory=list)
    message: str = ""
    source: str = ""
    #: Problems found while reading the rule; a rule with errors is not used.
    errors: list[str] = field(default_factory=list)

    @classmethod
    def from_dict(cls, raw: dict[str, Any], source: str = "") -> GuardrailRule:
        errors: list[str] = []
        rule_id = str(raw.get("id") or "").strip()
        if not rule_id:
            errors.append("a rule has no id")
            rule_id = "unnamed"
        label = f"rule {rule_id}"

        for key in raw:
            if key not in _KNOWN_RULE_KEYS:
                errors.append(f"{label}: unknown key '{key}'")
        when = raw.get("when", {}) or {}
        if not isinstance(when, dict):
            errors.append(f"{label}: 'when' must be a mapping")
            when = {}
        for key in when:
            if key not in KNOWN_CONDITIONS:
                errors.append(f"{label}: unknown condition '{key}'")

        def _compile(key: str) -> re.Pattern[str] | None:
            pattern = when.get(key)
            if pattern in (None, ""):
                return None
            try:
                return re.compile(str(pattern))
            except re.error as exc:
                errors.append(f"{label}: invalid regex in '{key}': {exc}")
                return None

        def _int(key: str) -> int | None:
            value = when.get(key)
            if value is None:
                return None
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                errors.append(f"{label}: '{key}' must be a positive integer")
                return None
            return value

        def _flag(key: str) -> bool:
            value = when.get(key, False)
            if not isinstance(value, bool):
                errors.append(f"{label}: '{key}' must be true or false")
                return False
            return value

        action_raw = raw.get("action", "deny")
        try:
            action = GuardrailAction(action_raw)
        except ValueError:
            errors.append(f"{label}: unknown action '{action_raw}'")
            action = GuardrailAction.DENY

        tools = when.get("tool", [])
        if isinstance(tools, str):
            tools = [tools]
        branches = when.get("branch", [])
        if isinstance(branches, str):
            branches = [branches]
        globs = when.get("path_glob")
        return cls(
            id=rule_id,
            description=str(raw.get("description", "")),
            action=action,
            tools=[str(t) for t in tools or []],
            path_prefix=str(when["path_prefix"]) if when.get("path_prefix") else None,
            path_regex=_compile("path_regex"),
            path_glob=glob_to_regex(str(globs)) if globs else None,
            content_regex=_compile("content_regex"),
            command_pattern=_compile("command_pattern"),
            content_max_lines=_int("content_max_lines"),
            content_max_bytes=_int("content_max_bytes"),
            forbidden_strings=[str(s) for s in when.get("forbidden_strings", []) or []],
            new_file_max_lines=_int("new_file_max_lines"),
            adds_regex=_compile("adds_regex"),
            deletes_tests=_flag("deletes_tests"),
            adds_dependency=_flag("adds_dependency"),
            branches=[glob_to_regex(str(b)) for b in branches or []],
            message=str(raw.get("message", "")),
            source=source,
            errors=errors,
        )

    def matches_tool(self, tool_name: str) -> bool:
        return not self.tools or tool_name in self.tools

    @property
    def semantic(self) -> bool:
        return self.deletes_tests or self.adds_dependency


@dataclass
class GuardrailDecision:
    """Outcome of evaluating all rules against one tool call."""

    action: GuardrailAction
    triggered: list[GuardrailRule] = field(default_factory=list)
    message: str = ""
    #: What the semantic conditions found, per rule id (tests removed, deps added).
    details: dict[str, list[str]] = field(default_factory=dict)

    def should_block(self) -> bool:
        return self.action in (GuardrailAction.DENY, GuardrailAction.REQUIRE_APPROVAL)


# ---------------------------------------------------------------------------
# Loader (kept for callers that only want the rules)
# ---------------------------------------------------------------------------


def load_guardrails(project_root: Path) -> list[GuardrailRule]:
    """The rules that apply to ``project_root`` (a project or one of its worktrees)."""
    from .guardrail_policy import load_policy

    return load_policy(Path(project_root)).rules


# ---------------------------------------------------------------------------
# Evaluator
# ---------------------------------------------------------------------------


def _get_path(tool_input: dict[str, Any]) -> str:
    return str(
        tool_input.get("file_path")
        or tool_input.get("notebook_path")
        or tool_input.get("path")
        or ""
    )


def _get_content(tool_input: dict[str, Any]) -> str:
    edits = tool_input.get("edits")
    if isinstance(edits, list):
        return "\n".join(
            str(e.get("new_string", "")) for e in edits if isinstance(e, dict)
        )
    return str(
        tool_input.get("content")
        or tool_input.get("new_string")
        or tool_input.get("new_str")
        or ""
    )


def relative_path(raw: str, root: Path | None) -> str:
    """``raw`` as a POSIX path relative to ``root`` when it lies inside it."""
    text = raw.replace("\\", "/")
    if root is not None and raw:
        candidate = Path(raw)
        if candidate.is_absolute():
            try:
                return candidate.resolve().relative_to(root.resolve()).as_posix()
            except (ValueError, OSError):
                return text
    while text.startswith("./"):
        text = text[2:]
    return text


@dataclass
class CallContext:
    """What the semantic conditions need beyond the tool input."""

    root: Path | None = None  # where the agent's files are (a worktree, often)
    branch: str | None = None
    _cache: tuple[str, str, bool] | None = None

    def _file(self, path: str) -> Path | None:
        if self.root is None or not path:
            return None
        candidate = Path(path)
        if not candidate.is_absolute():
            candidate = self.root / candidate
        try:
            resolved = candidate.resolve()
            resolved.relative_to(self.root.resolve())
        except (ValueError, OSError):
            return None  # outside the repo: the path guard answers for it
        return resolved

    def contents(
        self, tool_name: str, tool_input: dict[str, Any]
    ) -> tuple[str, str, bool]:
        """(text before, text after, file existed) for a write call."""
        if self._cache is not None:
            return self._cache
        target = self._file(_get_path(tool_input))
        before = ""
        exists = False
        if target is not None and target.is_file():
            exists = True
            try:
                before = target.read_text(encoding="utf-8", errors="replace")
            except OSError:
                before = ""
        if tool_name in ("Edit", "MultiEdit"):
            raw_edits = (
                tool_input.get("edits") if tool_name == "MultiEdit" else [tool_input]
            )
            edits = [e for e in raw_edits or [] if isinstance(e, dict)]
            after = before
            for edit in edits:
                old = str(edit.get("old_string", ""))
                new = str(edit.get("new_string", ""))
                if old:
                    count = -1 if edit.get("replace_all") else 1
                    after = after.replace(old, new, count)
            if not exists:  # an edit of a file we cannot read: judge the fragments
                before = "\n".join(str(e.get("old_string", "")) for e in edits)
                after = "\n".join(str(e.get("new_string", "")) for e in edits)
        else:
            after = str(tool_input.get("content") or "")
        self._cache = (before, after, exists)
        return self._cache


_RM_COMMAND = re.compile(
    r"(?:^|[;&|]\s*|\s)(?:git\s+rm|rm|del|Remove-Item|rmdir)\s+([^;&|]+)"
)


def _deleted_test_paths(command: str) -> list[str]:
    from .guardrail_semantics import is_test_path

    found = []
    for match in _RM_COMMAND.finditer(command):
        for word in match.group(1).split():
            word = word.strip("'\"")
            if not word.startswith("-") and is_test_path(word):
                found.append(word)
    return found


def _rule_matches(
    rule: GuardrailRule,
    tool_name: str,
    tool_input: dict[str, Any],
    context: CallContext | None = None,
    details: dict[str, list[str]] | None = None,
) -> bool:
    if rule.errors or not rule.matches_tool(tool_name):
        return False
    if rule.branches:
        branch = context.branch if context else None
        if not branch or not any(p.match(branch) for p in rule.branches):
            return False

    root = context.root if context else None
    path = relative_path(_get_path(tool_input), root)
    if rule.path_prefix and not path.startswith(rule.path_prefix.removeprefix("./")):
        return False
    if rule.path_regex and not rule.path_regex.search(path):
        return False
    if rule.path_glob and not rule.path_glob.match(path):
        return False

    if tool_name == "Bash":
        return _command_matches(rule, str(tool_input.get("command", "")), details)

    content = _get_content(tool_input)
    if rule.command_pattern:
        return False
    if rule.content_regex and not rule.content_regex.search(content):
        return False
    if (
        rule.content_max_lines is not None
        and content.count("\n") + 1 <= rule.content_max_lines
    ):
        return False
    if (
        rule.content_max_bytes is not None
        and len(content.encode("utf-8")) <= rule.content_max_bytes
    ):
        return False
    if rule.forbidden_strings and not any(n in content for n in rule.forbidden_strings):
        return False

    needs_files = (
        rule.semantic or rule.adds_regex or rule.new_file_max_lines is not None
    )
    if not needs_files:
        return True
    if tool_name not in WRITE_TOOLS:
        return False
    return _file_change_matches(rule, tool_name, tool_input, path, context, details)


def _command_matches(
    rule: GuardrailRule, command: str, details: dict[str, list[str]] | None
) -> bool:
    if rule.command_pattern and not rule.command_pattern.search(command):
        return False
    content_only = (
        rule.adds_dependency
        or rule.adds_regex
        or rule.new_file_max_lines is not None
        or rule.content_regex
        or rule.content_max_lines is not None
        or rule.content_max_bytes is not None
        or rule.forbidden_strings
    )
    if content_only:
        return False  # judged on file contents, which a command does not carry
    if rule.deletes_tests:
        removed = _deleted_test_paths(command)
        if not removed:
            return False
        if details is not None:
            details[rule.id] = removed
    return True


def _file_change_matches(
    rule: GuardrailRule,
    tool_name: str,
    tool_input: dict[str, Any],
    path: str,
    context: CallContext | None,
    details: dict[str, list[str]] | None,
) -> bool:
    from .guardrail_semantics import added_dependencies, removed_tests

    before, after, exists = (context or CallContext()).contents(tool_name, tool_input)
    if rule.new_file_max_lines is not None and (
        exists or after.count("\n") + 1 <= rule.new_file_max_lines
    ):
        return False
    if rule.adds_regex and len(rule.adds_regex.findall(after)) <= len(
        rule.adds_regex.findall(before)
    ):
        return False
    found: list[str] = []
    if rule.deletes_tests:
        found = removed_tests(path, before, after)
        if not found:
            return False
    if rule.adds_dependency:
        added = added_dependencies(path, before, after)
        if not added:
            return False
        found = found + added
    if found and details is not None:
        details[rule.id] = found
    return True


def evaluate_rules(
    rules: list[GuardrailRule],
    tool_name: str,
    tool_input: dict[str, Any],
    context: CallContext | None = None,
) -> GuardrailDecision:
    """Evaluate all rules and return the strictest decision."""
    details: dict[str, list[str]] = {}
    triggered = [
        r for r in rules if _rule_matches(r, tool_name, tool_input, context, details)
    ]
    if not triggered:
        return GuardrailDecision(action=GuardrailAction.ALLOW)

    strongest = max(triggered, key=lambda r: ACTION_PRIORITY[r.action])
    parts = []
    for rule in triggered:
        line = f"[{rule.id}] {rule.description or '(no description)'}"
        if rule.message:
            line += f" — {rule.message}"
        if rule.id in details:
            line += f" ({', '.join(details[rule.id][:10])})"
        parts.append(line)
    return GuardrailDecision(
        action=strongest.action,
        triggered=triggered,
        message="Guardrail triggered:\n  " + "\n  ".join(parts),
        details=details,
    )


# ---------------------------------------------------------------------------
# SDK hook integration
# ---------------------------------------------------------------------------


def _deny(reason: str) -> dict[str, Any]:
    return {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }


async def guardrails_hook(
    input_data: dict[str, Any],
    tool_use_id: str | None = None,
    context: Any | None = None,
    *,
    project_root: Path | None = None,
) -> dict[str, Any]:
    """Pre-tool-use hook that enforces user-defined guardrails.

    Returns an empty dict when the call is allowed or only triggers warnings.
    Returns a ``hookSpecificOutput`` with ``permissionDecision: deny`` when a
    rule blocks the call, when an approval is still pending, or when the
    policy itself is invalid.
    """
    from . import guardrail_ledger as ledger
    from .guardrail_policy import current_branch, load_policy, main_project

    tool_name = str(input_data.get("tool_name") or "")
    tool_input = input_data.get("tool_input") or {}
    if not isinstance(tool_input, dict):
        return {}

    root = Path(project_root) if project_root else Path.cwd()
    policy = load_policy(root)
    if policy.errors:
        if tool_name in WRITE_TOOLS or tool_name == "Bash":
            return _deny(
                "The project's guardrails are invalid, so no write or command runs "
                "until they are fixed (Settings > Guardrails):\n  "
                + "\n  ".join(policy.errors[:10])
            )
        return {}
    if not policy.rules:
        return {}

    branch = current_branch(root) if any(r.branches for r in policy.rules) else None
    decision = evaluate_rules(
        policy.rules, tool_name, tool_input, CallContext(root=root, branch=branch)
    )
    if decision.action == GuardrailAction.ALLOW:
        return {}

    project = main_project(root)
    target = ledger.target_of(tool_name, tool_input, root)
    if decision.action == GuardrailAction.WARN:
        logger.warning("Guardrail WARN: %s", decision.message)
        ledger.record(project, decision, tool_name, target, root)
        return {}

    if decision.action == GuardrailAction.REQUIRE_APPROVAL:
        if ledger.consume_approval(project, decision, target):
            ledger.record(
                project, decision, tool_name, target, root, outcome="approved"
            )
            return {}
        ledger.record(project, decision, tool_name, target, root, outcome="pending")
        return _deny(
            "Human approval required before this action. The request is waiting in "
            "Settings > Guardrails; once it is approved, the same call goes through. "
            "Carry on with work that does not need it, or stop and say what you are "
            "waiting for.\n" + decision.message
        )

    ledger.record(project, decision, tool_name, target, root)
    return _deny(decision.message)

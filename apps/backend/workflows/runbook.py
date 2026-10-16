"""The procedure a RUN task plays, read from what the `procedure` phase wrote.

`skills/tooling/runbook` makes a model write `<spec_dir>/workflow/procedure.md`
in a fixed shape — an operation, preconditions, numbered steps each with its
command, its expected effect and a check, whether it can be undone, a final
verification, parameters still to supply. This module turns that text into
data the executor (`workflows/execute.py`) can play step by step, and refuses
what it cannot play rather than guessing: a step with no command, a parameter
nobody supplied, a `[NEEDS CLARIFICATION]` left open.

The text is the model's output, so it is data: nothing here executes anything,
and a command only reaches a shell through the project's allowlist, in the
executor.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from pathlib import Path

__all__ = ["Runbook", "RunbookStep", "RunbookError", "parse_runbook", "load_runbook"]

PROCEDURE_FILE = "procedure.md"

_SECTION_RE = re.compile(r"^##\s+(?P<title>.+?)\s*$", re.MULTILINE)
_STEP_RE = re.compile(r"^###\s+(?P<number>\d+)\.\s*(?P<name>.+?)\s*$", re.MULTILINE)
_COMMAND_RE = re.compile(
    r"^Commande\s*:\s*`(?P<cmd>[^`]+)`", re.MULTILINE | re.IGNORECASE
)
_CHECK_RE = re.compile(r"vérifier par\s*:\s*`(?P<cmd>[^`]+)`", re.IGNORECASE)
_REVERSIBLE_RE = re.compile(
    r"^Réversible\s*:\s*(?P<answer>oui|non)", re.MULTILINE | re.IGNORECASE
)
_UNDO_RE = re.compile(
    r"^Réversible\s*:\s*oui\s*\(`(?P<cmd>[^`]+)`\)", re.MULTILINE | re.IGNORECASE
)
_FINAL_RE = re.compile(r"commande\s*:\s*`(?P<cmd>[^`]+)`", re.IGNORECASE)
_ENV_RE = re.compile(
    r"^Environnement\s*:\s*(?P<env>.+?)\s*$", re.MULTILINE | re.IGNORECASE
)
_PARAM_RE = re.compile(r"^-\s*`(?P<name>[A-Za-z_][A-Za-z0-9_]*)`", re.MULTILINE)
_CLARIFY_RE = re.compile(r"\[NEEDS CLARIFICATION", re.IGNORECASE)
_PLACEHOLDER_RE = re.compile(r"<[A-Z_][A-Z0-9_]*>|\{[A-Z_][A-Z0-9_]*\}")

#: What the `Environnement :` line says when the procedure stays in the worktree.
WORKTREE_ONLY = "worktree"


class RunbookError(Exception):
    """The procedure cannot be played as written. Says what to change."""


@dataclass(frozen=True)
class RunbookStep:
    number: int
    name: str
    command: str
    check: str | None = None
    reversible: bool = True
    undo: str | None = None


@dataclass(frozen=True)
class Runbook:
    operation: str
    environment: str
    steps: tuple[RunbookStep, ...]
    final_check: str | None = None
    parameters: tuple[str, ...] = ()
    open_questions: int = 0
    sha256: str = ""
    source: Path | None = None
    sections: dict[str, str] = field(default_factory=dict)

    @property
    def irreversible_steps(self) -> tuple[RunbookStep, ...]:
        return tuple(s for s in self.steps if not s.reversible)

    def blockers(self) -> list[str]:
        """Why this procedure must not start. Empty when it may."""
        out: list[str] = []
        if not self.steps:
            out.append("the procedure declares no step")
        if self.parameters:
            out.append("parameters still to supply: " + ", ".join(self.parameters))
        if self.open_questions:
            out.append(f"{self.open_questions} open [NEEDS CLARIFICATION] question(s)")
        for step in self.steps:
            if _PLACEHOLDER_RE.search(step.command):
                out.append(
                    f"step {step.number} ({step.name}) has a placeholder in its command"
                )
        return out

    def describe(self) -> str:
        lines = [
            f"Procedure: {self.operation or '(untitled)'}",
            f"Environment: {self.environment}",
        ]
        for step in self.steps:
            flag = "" if step.reversible else "  [IRREVERSIBLE]"
            lines.append(f"  {step.number}. {step.name}{flag}")
            lines.append(f"     $ {step.command}")
        if self.final_check:
            lines.append(f"  final check: $ {self.final_check}")
        return "\n".join(lines)


def _sections(text: str) -> dict[str, str]:
    """``{"étapes": "...", ...}`` — section bodies keyed by lower-cased title."""
    out: dict[str, str] = {}
    matches = list(_SECTION_RE.finditer(text))
    for i, m in enumerate(matches):
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        out[m.group("title").strip().lower()] = text[m.end() : end]
    return out


def _find(sections: dict[str, str], *names: str) -> str:
    for key, body in sections.items():
        if any(key.startswith(n) for n in names):
            return body
    return ""


def parse_runbook(text: str, *, source: Path | None = None) -> Runbook:
    """A `Runbook` from the text the `procedure` phase wrote.

    Lenient on prose, strict on what matters: a step without a backticked
    command is a `RunbookError`, because a step the executor would have to
    interpret is a step the model would be executing.
    """
    sections = _sections(text)
    operation_body = _find(sections, "opération", "operation")
    operation = next(
        (
            line.strip()
            for line in operation_body.splitlines()
            if line.strip()
            and not _ENV_RE.match(line)
            and not line.lower().startswith("source")
        ),
        "",
    )
    env_match = _ENV_RE.search(operation_body) or _ENV_RE.search(text)
    environment = env_match.group("env").strip() if env_match else WORKTREE_ONLY
    if environment.lower().startswith(("arbre de travail", "worktree", "<nom déclaré")):
        environment = WORKTREE_ONLY

    steps: list[RunbookStep] = []
    steps_body = _find(sections, "étapes", "etapes", "steps")
    step_matches = list(_STEP_RE.finditer(steps_body))
    for i, m in enumerate(step_matches):
        end = (
            step_matches[i + 1].start()
            if i + 1 < len(step_matches)
            else len(steps_body)
        )
        body = steps_body[m.end() : end]
        cmd = _COMMAND_RE.search(body)
        number = int(m.group("number"))
        name = m.group("name").strip()
        if cmd is None:
            raise RunbookError(
                f"step {number} ({name}) has no `Commande : \\`…\\`` line"
            )
        check = _CHECK_RE.search(body)
        rev = _REVERSIBLE_RE.search(body)
        reversible = rev is None or rev.group("answer").lower() == "oui"
        undo = _UNDO_RE.search(body)
        steps.append(
            RunbookStep(
                number=number,
                name=name,
                command=cmd.group("cmd").strip(),
                check=check.group("cmd").strip() if check else None,
                reversible=reversible,
                undo=undo.group("cmd").strip() if undo else None,
            )
        )

    final_body = _find(sections, "vérification finale", "verification finale", "final")
    final = _FINAL_RE.search(final_body)
    params_body = _find(sections, "paramètres", "parametres", "parameters")
    parameters = tuple(dict.fromkeys(_PARAM_RE.findall(params_body)))

    return Runbook(
        operation=operation,
        environment=environment,
        steps=tuple(steps),
        final_check=final.group("cmd").strip() if final else None,
        parameters=parameters,
        open_questions=len(_CLARIFY_RE.findall(text)),
        sha256=hashlib.sha256(text.encode("utf-8")).hexdigest(),
        source=source,
        sections=sections,
    )


def load_runbook(spec_dir: Path) -> Runbook:
    """The procedure of a spec, or a `RunbookError` naming what is missing."""
    path = Path(spec_dir) / "workflow" / PROCEDURE_FILE
    if not path.is_file():
        raise RunbookError(
            f"no procedure at {path} — the `procedure` phase has not written one"
        )
    return parse_runbook(path.read_text(encoding="utf-8"), source=path)

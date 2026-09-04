"""Reading a spec-kit project's constitution, when the target project is one.

[spec-kit](https://github.com/github/spec-kit) (GitHub, MIT) is a
spec-driven-development toolkit with its own `specify` CLI, and a project
initialised with it keeps its binding rules in `.specify/memory/constitution.md`
— the file its own commands check every plan against.

WorkPilot builds *other people's* projects. When one of them is a spec-kit
project, those rules are the house rules, and an agent that has not read them
will produce a plan the project's own tooling would reject. Reading one
markdown file when it happens to be there is the whole integration: there is no
dependency to install, nothing to detect at build time, and a project without
`.specify/` costs a single `is_file()` call.

**Only the constitution.** spec-kit also keeps `specs/###-name/spec.md` and
`tasks.md` — its own equivalents of `spec.md` and `implementation_plan.json`.
Reading those would mean deciding which of two specs a build is following, and
that is a question with no good answer: WorkPilot has its own spec, written by
its own pipeline, for this task. The constitution is different because it is
not about this task at all — it is about the project, and it holds whichever
spec is driving the work.

Never raises, never blocks: an unreadable or empty constitution yields no
section, and the build proceeds exactly as it did before.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger(__name__)

__all__ = [
    "CONSTITUTION_PATH",
    "Constitution",
    "find_constitution",
    "format_constitution_for_prompt",
]

CONSTITUTION_PATH = (".specify", "memory", "constitution.md")

# How much of the file reaches a prompt. A constitution is a page of
# principles; anything past this is either a document that outgrew its purpose
# or one this section should not be inlining on every subtask.
_MAX_CHARS = 6000

# A line stating a binding rule. spec-kit's template writes principles as
# headings with MUST/SHALL/NEVER in the body, and projects write them as
# bullets — both are read, because what matters is the modal verb, not the
# markup around it.
_BINDING = re.compile(r"\b(MUST NOT|MUST|SHALL NOT|SHALL|NEVER|REQUIRED)\b")


@dataclass(frozen=True)
class Constitution:
    """A spec-kit constitution found in the project being built."""

    path: Path
    text: str

    @property
    def binding_lines(self) -> list[str]:
        """The lines that state a rule rather than describe one.

        Used for the summary count only. The prompt gets the document, not
        this extraction: a rule quoted out of its section loses the scope it
        was qualified by, and "MUST" appearing in a sentence about what the
        project used to do would be quoted as current law.
        """
        return [
            line.strip()
            for line in self.text.splitlines()
            if _BINDING.search(line) and line.strip()
        ]


def find_constitution(project_dir: Path) -> Constitution | None:
    """The project's spec-kit constitution, or None when it is not one."""
    try:
        path = project_dir.joinpath(*CONSTITUTION_PATH)
        if not path.is_file():
            return None
        text = path.read_text(encoding="utf-8").strip()
    except (OSError, UnicodeDecodeError) as exc:
        logger.debug("could not read a spec-kit constitution: %s", exc)
        return None

    if not text:
        # An `specify init` that was never followed by `/speckit.constitution`
        # leaves the template behind. An empty file is not a set of rules.
        return None
    return Constitution(path=path, text=text)


def format_constitution_for_prompt(project_dir: Path) -> str:
    """The prompt section for a spec-kit project, or "" for any other project.

    Handed as text rather than as a path, unlike the library documentation the
    preflight stages: this is short, it applies to every subtask rather than to
    the one that mentions a library, and a rule an agent has to decide to go
    and read is a rule it will sometimes not read.
    """
    found = find_constitution(project_dir)
    if found is None:
        return ""

    body = found.text
    truncated = len(body) > _MAX_CHARS
    if truncated:
        body = body[:_MAX_CHARS].rstrip()

    where = "/".join(CONSTITUTION_PATH)
    lines = [
        "## PROJECT CONSTITUTION (spec-kit)",
        "",
        f"This project is a spec-kit project and states its own binding rules in"
        f" `{where}`. They apply to the plan and to the code, and they outrank"
        " any convention you would otherwise infer from the codebase — the"
        " project wrote them down precisely because inference was getting it"
        " wrong.",
        "",
        "Where a rule here conflicts with the task, do not silently pick one:"
        " follow the rule and say in your output that you did, so the person"
        " reviewing sees the conflict.",
        "",
        "---",
        "",
        body,
    ]
    if truncated:
        lines += ["", f"[truncated — read the full file at `{where}`]"]
    return "\n".join(lines)

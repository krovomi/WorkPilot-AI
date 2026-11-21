"""Session templates: a ready-made crew for the four kinds of work people start.

A template is a list of roles, each with the model tier it deserves and two
flags the budget step reads (``composition.py``):

* ``critical`` — the role decides whether the result is right (the reviewer of
  a feature, the debugger of an incident). A budget steps it down last.
* ``optional`` — the role adds value but the work gets done without it (the
  tester of a project with no test suite, the documenter of an incident). A
  budget drops it before it touches a critical role.

``scales`` marks the role whose count follows the size of the work: one coder
for a small change, up to three for a large one.

Tiers are the registry's words (``models_registry``): ``flagship``,
``standard``, ``fast``. No model id is written here; the composition resolves
each tier on the providers the person chose.
"""

from __future__ import annotations

from dataclasses import dataclass

from tasks.classify import TaskKind


@dataclass(frozen=True)
class RoleSlot:
    """One role of a template."""

    role: str
    tier: str
    critical: bool = False
    optional: bool = False
    scales: bool = False


@dataclass(frozen=True)
class SessionTemplate:
    """A pre-set composition of roles."""

    key: str
    roles: tuple[RoleSlot, ...]


BUG_FIX = SessionTemplate(
    "bug_fix",
    (
        RoleSlot("debugger", "standard", critical=True),
        RoleSlot("coder", "standard"),
        RoleSlot("tester", "fast", optional=True),
    ),
)

NEW_FEATURE = SessionTemplate(
    "new_feature",
    (
        RoleSlot("architect", "flagship", critical=True),
        RoleSlot("coder", "standard", scales=True),
        RoleSlot("reviewer", "standard", critical=True),
        RoleSlot("tester", "fast", optional=True),
    ),
)

REFACTOR_MODULE = SessionTemplate(
    "refactor_module",
    (
        RoleSlot("architect", "flagship"),
        RoleSlot("coder", "standard", scales=True),
        RoleSlot("reviewer", "standard", critical=True),
        RoleSlot("tester", "fast", optional=True),
    ),
)

INCIDENT_RESPONSE = SessionTemplate(
    "incident_response",
    (
        RoleSlot("debugger", "flagship", critical=True),
        RoleSlot("coder", "standard"),
        RoleSlot("reviewer", "standard", critical=True),
        RoleSlot("documenter", "fast", optional=True),
    ),
)

# What a description too vague to classify gets: one coder and one reviewer,
# and a warning that says why (``vague_input``).
GENERIC = SessionTemplate(
    "generic",
    (
        RoleSlot("coder", "standard"),
        RoleSlot("reviewer", "standard", critical=True),
    ),
)

TEMPLATES: dict[str, SessionTemplate] = {
    t.key: t
    for t in (BUG_FIX, NEW_FEATURE, REFACTOR_MODULE, INCIDENT_RESPONSE, GENERIC)
}

# The kind of a card (``tasks.classify``) → the template that serves it.
_BY_KIND: dict[TaskKind, SessionTemplate] = {
    TaskKind.FEATURE: NEW_FEATURE,
    TaskKind.SPIKE: NEW_FEATURE,
    TaskKind.BUG_FIX: BUG_FIX,
    TaskKind.INVESTIGATION: BUG_FIX,
    TaskKind.HOTFIX: INCIDENT_RESPONSE,
    TaskKind.REFACTORING: REFACTOR_MODULE,
    TaskKind.UPGRADE: REFACTOR_MODULE,
}


def template_for_kind(kind: TaskKind) -> SessionTemplate:
    """The template of a card's kind; ``GENERIC`` for docs, tests and runs."""
    return _BY_KIND.get(kind, GENERIC)


__all__ = [
    "GENERIC",
    "TEMPLATES",
    "RoleSlot",
    "SessionTemplate",
    "template_for_kind",
]

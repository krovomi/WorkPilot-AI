"""The kind of a Kanban card, decided by the cheapest judge that knows.

Lot 0 of ``docs/architecture/kanban-task-types.md``. One workflow,
``feature-build``, is played for every card whatever its intent; the pieces
that would tell a bug from a feature exist and are not wired: the category
the user picked, the type of an imported item, the words of the title. This
module reads them, in that order, and spends no token doing it.

A kind is a verdict with a confidence and a source, so the UI can show it,
the user can change it, and a later lot can ask a model only when nothing
here knew (``confidence < AMBIGUOUS``). Pure: no I/O, no model.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Mapping
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

__all__ = [
    "AMBIGUOUS",
    "Classification",
    "TaskKind",
    "classify",
]


class TaskKind(str, Enum):
    """What a card asks for. ``FEATURE`` is the default and the current pipeline."""

    FEATURE = "feature"
    BUG_FIX = "bug_fix"
    HOTFIX = "hotfix"
    INVESTIGATION = "investigation"
    RUN = "run"
    REFACTORING = "refactoring"
    TEST = "test"
    DOCS = "docs"
    SPIKE = "spike"


#: Below this a verdict is a proposal: the UI says so, and a later lot may ask
#: a model. Keywords alone never reach it; a category or an imported type does.
AMBIGUOUS = 0.6


@dataclass(frozen=True)
class Classification:
    kind: TaskKind
    confidence: float
    #: ``user`` (chosen in the UI), ``category`` (the task's category),
    #: ``import`` (the type of a Jira / Azure DevOps / label-bearing item),
    #: ``keywords`` (the title and description), ``default``.
    source: str
    reasons: tuple[str, ...] = field(default=())

    @property
    def ambiguous(self) -> bool:
        return self.confidence < AMBIGUOUS

    def as_metadata(self) -> dict[str, Any]:
        """The fields written to ``task_metadata.json``."""
        return {
            "kind": self.kind.value,
            "kindConfidence": round(self.confidence, 2),
            "kindSource": self.source,
        }


# ── the category the user picked ────────────────────────────────────────────

_BY_CATEGORY: Mapping[str, TaskKind] = {
    "feature": TaskKind.FEATURE,
    "bug_fix": TaskKind.BUG_FIX,
    "refactoring": TaskKind.REFACTORING,
    "documentation": TaskKind.DOCS,
    "testing": TaskKind.TEST,
    "infrastructure": TaskKind.RUN,
    # security, performance, ui_ux: a feature-shaped build, but the user did
    # not say "feature", so the words of the title still get their say.
    # Security and performance are lenses of the review, not workflows.
}

# ── the type of an imported item ─────────────────────────────────────────────

_BY_IMPORTED_TYPE: Mapping[str, TaskKind] = {
    "bug": TaskKind.BUG_FIX,
    "defect": TaskKind.BUG_FIX,
    "incident": TaskKind.HOTFIX,
    "hotfix": TaskKind.HOTFIX,
    "spike": TaskKind.SPIKE,
    "research": TaskKind.SPIKE,
    "investigation": TaskKind.INVESTIGATION,
    "task": TaskKind.FEATURE,
    "story": TaskKind.FEATURE,
    "user story": TaskKind.FEATURE,
    "epic": TaskKind.FEATURE,
    "documentation": TaskKind.DOCS,
    "tech debt": TaskKind.REFACTORING,
    "tech-debt": TaskKind.REFACTORING,
    "technical debt": TaskKind.REFACTORING,
}

# ── the words of the title and description ───────────────────────────────────
#
# Word-boundary patterns on a lower-cased, accent-stripped text, French and
# English together: a Kanban in Bordeaux names its bugs in both. Order is
# specificity: a `run` verb beats a `bug` noun only when nothing says bug.

_KEYWORDS: tuple[tuple[TaskKind, tuple[str, ...]], ...] = (
    (
        TaskKind.INVESTIGATION,
        (
            r"\bpourquoi\b",
            r"\bcomprendre\b",
            r"\banalyser\b",
            r"\bdiagnostiquer\b",
            r"\binvestiguer\b",
            r"\benquete\b",
            r"\bwhy\b",
            r"\binvestigat(e|ion)\b",
            r"\bdiagnos(e|is|tic)\b",
            r"\broot cause\b",
            r"\bflaky\b",
            r"\bintermittent\b",
            r"\baleatoire\b",
        ),
    ),
    (
        TaskKind.SPIKE,
        (
            r"\bpoc\b",
            r"\bprototype\b",
            r"\bproof of concept\b",
            r"\bspike\b",
            r"\bevaluer\b",
            r"\bcomparer\b",
            r"\bevaluate\b",
            r"\bcompare\b",
            r"\bfeasibilit",
            r"\bfaisabilit",
        ),
    ),
    (
        TaskKind.RUN,
        (
            r"\brelancer\b",
            r"\bredemarrer\b",
            r"\bpurger\b",
            r"\bvider le cache\b",
            r"\brotation\b",
            r"\btourner (la|une) cle\b",
            r"\bmigrer les donnees\b",
            r"\bmigration de donnees\b",
            r"\bdeployer\b",
            r"\bdeploiement\b",
            r"\bexecuter le (job|batch|traitement)\b",
            r"\brestart\b",
            r"\brerun\b",
            r"\bre-run\b",
            r"\bpurge\b",
            r"\bclear the cache\b",
            r"\brotate\b",
            r"\bdeploy(ment)?\b",
            r"\brun the (job|batch|migration)\b",
            r"\bdata migration\b",
            r"\bbackfill\b",
        ),
    ),
    (
        TaskKind.BUG_FIX,
        (
            r"\bbug\b",
            r"\bcorriger\b",
            r"\bcorrection\b",
            r"\bplante\b",
            r"\bcrash\b",
            r"\bregression\b",
            r"\berreur\b",
            r"\bexception\b",
            r"\bne (fonctionne|marche) (plus|pas)\b",
            r"\bfix\b",
            r"\bbroken\b",
            r"\bdoes ?n.?t work\b",
            r"\bno longer works\b",
            r"\bfails?\b",
            r"\bstack ?trace\b",
            r"\bnullreference",
        ),
    ),
    (
        TaskKind.REFACTORING,
        (
            r"\brefactor",
            r"\bnettoyer\b",
            r"\bsimplifier\b",
            r"\bdecoupler\b",
            r"\bextraire\b",
            r"\bdette technique\b",
            r"\btech(nical)? debt\b",
            r"\bclean ?up\b",
            r"\bsimplify\b",
            r"\bdecouple\b",
            r"\bextract\b",
            r"\brename\b",
            r"\brenommer\b",
        ),
    ),
    (
        TaskKind.TEST,
        (
            r"\bcouvrir\b",
            r"\bcouverture\b",
            r"\btests? (unitaires?|d.integration|pour)\b",
            r"\b(unit|integration) tests?\b",
            r"\btest coverage\b",
            r"\bwrite tests\b",
            r"\bajouter des tests\b",
        ),
    ),
    (
        TaskKind.DOCS,
        (
            r"\bdocumenter\b",
            r"\bdocumentation\b",
            r"\breadme\b",
            r"\bguide\b",
            r"\bdocument\b",
            r"\bchangelog\b",
        ),
    ),
)

_URGENCY = (
    r"\burgent\b",
    r"\burgence\b",
    r"\bhotfix\b",
    r"\bprod(uction)?\b",
    r"\bincident\b",
    r"\bbloquant\b",
    r"\bblocking\b",
    r"\bdown\b",
    r"\bp[01]\b",
    r"\bcritical\b",
    r"\bcritique\b",
)

_URGENT_PRIORITIES = frozenset({"urgent", "critical"})


def _normalise(text: str) -> str:
    text = unicodedata.normalize("NFKD", text or "")
    text = "".join(c for c in text if not unicodedata.combining(c))
    return re.sub(r"\s+", " ", text.lower()).strip()


def _matches(text: str, patterns: tuple[str, ...]) -> list[str]:
    found: list[str] = []
    for pattern in patterns:
        m = re.search(pattern, text)
        if m:
            found.append(m.group(0))
    return found


def _is_urgent(text: str, metadata: Mapping[str, Any]) -> tuple[bool, str]:
    priority = str(metadata.get("priority") or "").lower()
    if priority in _URGENT_PRIORITIES:
        return True, f"priority={priority}"
    words = _matches(text, _URGENCY)
    if words:
        return True, "words: " + ", ".join(words[:3])
    return False, ""


def _imported_type(metadata: Mapping[str, Any]) -> str | None:
    for key in ("jiraType", "azureDevOpsType", "importedType"):
        value = metadata.get(key)
        if value:
            return str(value)
    labels = metadata.get("labels")
    if isinstance(labels, (list, tuple)):
        for label in labels:
            if str(label).lower() in _BY_IMPORTED_TYPE:
                return str(label)
    return None


def classify(
    title: str,
    description: str = "",
    metadata: Mapping[str, Any] | None = None,
) -> Classification:
    """The kind of a card, from what is already known about it.

    1. ``metadata["kind"]`` chosen by the user (``kindSource == "user"``) wins
       and is never overwritten.
    2. ``metadata["category"]`` picked in the form.
    3. The type of an imported item (Jira, Azure DevOps) or a recognised label.
    4. The words of the title (weighed double) and description.
    5. ``FEATURE``, low confidence.

    A ``bug_fix`` with urgency (priority ``urgent`` / ``critical``, or words
    like *prod*, *incident*, *hotfix*) is a ``hotfix``.
    """
    metadata = metadata or {}
    text = _normalise(f"{title} {title} {description}")

    if metadata.get("kindSource") == "user" and metadata.get("kind"):
        try:
            kind = TaskKind(str(metadata["kind"]))
        except ValueError:
            kind = None
        if kind is not None:
            return Classification(kind, 1.0, "user", ("chosen in the UI",))

    def _with_urgency(kind: TaskKind, confidence: float, source: str, why: str):
        if kind is TaskKind.BUG_FIX:
            urgent, reason = _is_urgent(text, metadata)
            if urgent:
                return Classification(
                    TaskKind.HOTFIX, confidence, source, (why, f"urgent: {reason}")
                )
        return Classification(kind, confidence, source, (why,))

    category = str(metadata.get("category") or "").lower()
    if category in _BY_CATEGORY:
        return _with_urgency(
            _BY_CATEGORY[category], 0.9, "category", f"category={category}"
        )

    imported = _imported_type(metadata)
    if imported and imported.lower() in _BY_IMPORTED_TYPE:
        return _with_urgency(
            _BY_IMPORTED_TYPE[imported.lower()],
            0.85,
            "import",
            f"imported type={imported}",
        )

    # Keywords: the first family with a hit wins, in order of specificity;
    # two families hit → ambiguous, the first still proposed.
    hits: list[tuple[TaskKind, list[str]]] = []
    for kind, patterns in _KEYWORDS:
        found = _matches(text, patterns)
        if found:
            hits.append((kind, found))
    if hits:
        kind, found = hits[0]
        confidence = 0.75 if len(hits) == 1 else 0.5
        why = "words: " + ", ".join(found[:3])
        if len(hits) > 1:
            why += " (also " + ", ".join(k.value for k, _ in hits[1:]) + ")"
        return _with_urgency(kind, confidence, "keywords", why)

    return Classification(TaskKind.FEATURE, 0.3, "default", ("nothing said otherwise",))

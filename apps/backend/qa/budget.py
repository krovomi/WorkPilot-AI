"""How long the QA loop may keep going.

The pass budget and the recurring-issue threshold, in a module that imports
nothing else from `qa`: `loop`, `report` and `criteria` all read them, and
reaching them through `loop` made each of those imports a cycle.
"""

import os
from pathlib import Path

from phase_config import get_phase_thinking


def _read_int_env(name: str, default: int, *, minimum: int = 1) -> int:
    """Lit une variable d'env entière, retombe sur ``default`` si invalide."""
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return default
    return value if value >= minimum else default


# Seuil par défaut : 8 occurrences avant escalade humaine. L'ancien seuil de 3
# faisait escalader la boucle dès la 3ᵉ itération sur 50, dès qu'une issue
# persistait — y compris des faux positifs non-actionables comme « Cannot
# verify without runtime ». 8 laisse au fixer une vraie chance de converger
# tout en gardant un garde-fou contre les boucles infinies. Surchargeable via
# ``WORKPILOT_QA_RECURRING_THRESHOLD``.
RECURRING_ISSUE_THRESHOLD = _read_int_env(
    "WORKPILOT_QA_RECURRING_THRESHOLD", default=8, minimum=2
)

# The ceiling no effort level and no override goes past. It used to be the cap
# itself, at every effort: fifty reviewer + fixer rounds, each re-reading the
# diff, before anything stopped a loop that was not converging (audit F17).
MAX_QA_ITERATIONS = 50

# How many review passes the task's QA effort buys. The effort is the QA
# phase's own (`phaseThinking.qa`, default `high`): the knob the user turns for
# how hard QA works is the one that decides how long it may keep going.
QA_ITERATIONS_BY_EFFORT: dict[str, int] = {
    "none": 3,
    "low": 5,
    "medium": 8,
    "high": 12,
    "ultrathink": 20,
}
# A budget that wins over the effort (any build, any task), bounded by
# MAX_QA_ITERATIONS.
QA_MAX_ITERATIONS_ENV = "WORKPILOT_QA_MAX_ITERATIONS"


def qa_iteration_cap(spec_dir: Path) -> int:
    """The number of QA review passes this task may run."""
    raw = os.environ.get(QA_MAX_ITERATIONS_ENV, "").strip()
    if raw:
        try:
            override = int(raw)
        except ValueError:
            override = 0
        if override >= 1:
            return min(override, MAX_QA_ITERATIONS)
    try:
        effort = get_phase_thinking(spec_dir, "qa")
    except Exception:  # noqa: BLE001 - an unreadable metadata file is not a reason to loop 50 times
        effort = "high"
    return QA_ITERATIONS_BY_EFFORT.get(str(effort), QA_ITERATIONS_BY_EFFORT["high"])


def recurring_issue_threshold(cap: int) -> int:
    """Occurrences that escalate an issue to a human, within a budget of ``cap``.

    The default threshold (8) is more passes than `none`, `low` or `medium` buy:
    unclamped, an issue present in every pass would end on "maximum iterations"
    without the escalation report that says which issue kept coming back.
    """
    return max(2, min(RECURRING_ISSUE_THRESHOLD, cap))

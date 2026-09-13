"""archify integration: the renderer, the model, and the per-task delta.

`runtime` answers where archify is and whether it can run; `cli` calls it and
types the receipts; `evidence` collects what the codebase says without a model;
`ir` reads, pins and diffs the model; `authoring` writes one; `significance`
decides whether a task is worth mapping at all; `delta` compares two models and
records the six states the Kanban can be in.
"""

from .cli import ArchifyUnavailable, Receipt, compare, deliver, doctor, validate
from .delta import DeltaStatus, compare_models, read_status
from .ir import Continuity, IRError, check_id_continuity, pin_repository
from .runtime import Readiness, archify_root, check, node_executable
from .significance import Significance, assess

__all__ = [
    "ArchifyUnavailable",
    "Continuity",
    "DeltaStatus",
    "IRError",
    "Readiness",
    "Receipt",
    "Significance",
    "archify_root",
    "assess",
    "check",
    "check_id_continuity",
    "compare",
    "compare_models",
    "deliver",
    "doctor",
    "node_executable",
    "pin_repository",
    "read_status",
    "validate",
]

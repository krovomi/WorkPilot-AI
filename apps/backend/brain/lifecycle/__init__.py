"""The memory's lifecycle, explained: journal, trash, pins, conflicts.

| Module | Answers |
|---|---|
| `journal.py` | every decision on a memory, one Markdown line in the vault (merged by union) |
| `store.py` | forget (soft, restorable), restore, purge, pin, archive |
| `contradictions.py` | two notes that say opposite things, found without a model |
| `arbitration.py` | after a sync: safe rules settle a pair, the rest waits for a person |
| `advisor.py` | a model's opinion on one queued pair, asked by a person |
| `announce.py` | a queued pair told to the team, once, when the project asks (a port the notifications fill) |
| `scopes.py` | where a memory applies: a module, ``team:<name>`` or ``branch:<ref>`` |
| `maintainers.py` | who settles an escalated pair, per scope |
| `undo.py` | take a decision back: the last automatic one within the hour, or a merge |
| `folds.py` | the pattern a learning-loop merge folded in, kept so that the merge can be separated |
| `metrics.py` | restores, pins, conflicts and their resolution time, from the journal |
| `api.py` | ``/api/brain/memory/*`` (a server project's: ``shared_features/context_lifecycle.py``) |
| `embeddings.py` | the same pair in other words, read by an embeddings model the local Ollama already has (optional) |

Everything lives under ``knowledge/projects/<project>/memory/.lifecycle/`` —
inside the vault, so it syncs; hidden, so no agent recalls it. The conflict
queue, the pairs already announced and the project registry are this
machine's (``.workpilot-brain/``).
"""

from __future__ import annotations

from .arbitration import open_conflicts, resolve, review_pull
from .journal import JournalEntry, append, read
from .store import forget, pin, restore, trash

__all__ = [
    "JournalEntry",
    "append",
    "forget",
    "open_conflicts",
    "pin",
    "read",
    "resolve",
    "restore",
    "review_pull",
    "trash",
]

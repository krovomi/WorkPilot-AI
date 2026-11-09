"""Plan rehearsal: play an implementation plan against a snapshot of the repo.

Before a spec is built for real, its plan is walked subtask by subtask over the
tree the build would start from (a git ref, never the working copy). Nothing is
written and no model is called: the walk is algorithmic, so it is free, offline
and identical whatever provider the real build will use.

* :mod:`simulation.snapshot`: the files of the ref, read with ``git ls-tree``.
* :mod:`simulation.toolchains`: which manifest a verification command needs.
* :mod:`simulation.api_mocks`: schema-based responses for API verifications.
* :mod:`simulation.plan_rehearsal`: the walk itself and its findings.
* :mod:`simulation.engine`: the report the sandbox page shows.
"""

from .engine import rehearse_spec

__all__ = ["rehearse_spec"]

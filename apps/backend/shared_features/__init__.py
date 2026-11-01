"""The features of a server-mode project that every member shares: its board
(``shared_board``) and, declared in ``registry``, its roadmap, its ideation,
its index and the views that follow, as their files on the server's clone and
their runners as jobs; its Insights conversations (``insights``); its
memories (``context``); its GitHub repository or GitLab project, with each
person's own token (``forge``, ``forge_gitlab``), and the AI review of its
pull or merge requests as a job on the clone (``forge_review``); its analyses
(accessibility, i18n, documentation drift, flaky tests, technical debt) as
jobs whose reports every member reads (``analyses``); its dashboard,
analytics, sessions and costs, computed from its runs, its jobs and the
ledgers its agents keep in the clone (``workspace``, ``usage_ledger``).

See ``docs/architecture/server-mode.md``.
"""

from __future__ import annotations

from collections.abc import Callable

from fastapi import APIRouter


def mount_all(mount: Callable[[APIRouter, str], None]) -> None:
    """Mount each router with ``mount``, naming the feature its permission
    derives from (``server.authz.catalog.FEATURE_DOMAINS``)."""
    from shared_board.api import router as board
    from shared_board.engines import router as board_engines
    from shared_features.analyses import router as analyses
    from shared_features.api import feature_router
    from shared_features.context import router as context
    from shared_features.forge import router as forge
    from shared_features.forge_gitlab import router as forge_gitlab
    from shared_features.forge_review import GITHUB, GITLAB
    from shared_features.ideation import router as ideation
    from shared_features.insights import router as insights
    from shared_features.registry import FEATURES
    from shared_features.roadmap import router as roadmap
    from shared_features.workspace import router as workspace

    mount(board, "board")
    mount(board_engines, "board")
    for feature in FEATURES.values():
        mount(feature_router(feature), feature.key)
    mount(roadmap, "roadmap")
    mount(ideation, "ideation")
    mount(insights, "insights")
    mount(context, "context")
    mount(forge, "forge")
    mount(forge_gitlab, "forge")
    mount(GITHUB.router, "forge")
    mount(GITLAB.router, "forge")
    mount(analyses, "analyses")
    mount(workspace, "workspace")

"""The features of a server-mode project that every member shares: its board
(``shared_board``) and, declared in ``registry``, its roadmap, its ideation
and the views that follow, as their files on the server's clone and their
runners as jobs; its Insights conversations (``insights``).

See ``docs/architecture/server-mode.md``.
"""

from __future__ import annotations

from collections.abc import Callable

from fastapi import APIRouter


def mount_all(mount: Callable[[APIRouter, str], None]) -> None:
    """Mount each router with ``mount``, naming the feature its permission
    derives from (``server.authz.catalog.FEATURE_DOMAINS``)."""
    from shared_board.api import router as board
    from shared_features.api import feature_router
    from shared_features.ideation import router as ideation
    from shared_features.insights import router as insights
    from shared_features.registry import FEATURES
    from shared_features.roadmap import router as roadmap

    mount(board, "board")
    for feature in FEATURES.values():
        mount(feature_router(feature), feature.key)
    mount(roadmap, "roadmap")
    mount(ideation, "ideation")
    mount(insights, "insights")

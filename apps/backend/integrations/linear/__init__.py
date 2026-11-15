"""
Linear Integration
==================

Integration with Linear issue tracking: one Linear task per spec, moved
through its statuses by focused mini-agent calls (`updater.py`).
"""

from .updater import (
    STATUS_CANCELED,
    STATUS_DONE,
    STATUS_IN_PROGRESS,
    STATUS_IN_REVIEW,
    STATUS_TODO,
    LinearTaskState,
    create_linear_task,
    get_linear_api_key,
    is_linear_enabled,
    update_linear_status,
)

__all__ = [
    "LinearTaskState",
    "is_linear_enabled",
    "get_linear_api_key",
    "create_linear_task",
    "update_linear_status",
    "STATUS_TODO",
    "STATUS_IN_PROGRESS",
    "STATUS_IN_REVIEW",
    "STATUS_DONE",
    "STATUS_CANCELED",
]

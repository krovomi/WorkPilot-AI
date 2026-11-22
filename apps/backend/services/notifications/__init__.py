"""Multi-channel notification service.

Sends rich "PR ready" announcements (and other events: a long task's digest,
a memory conflict a sync queued) to Microsoft Teams, Slack, Discord, Google
Chat and generic webhooks.

Usage:
    from services.notifications import NotificationService, PRReadyNotification

    service = NotificationService.from_env(project_path)
    service.send_pr_ready(PRReadyNotification(...))
"""

from .memory_conflicts import install as _install_memory_conflict_notices
from .models import ChannelResult, NotificationChannel, PRReadyNotification
from .service import NotificationService

# The brain announces a queued memory conflict through this port: `brain` may
# not import `services` (the agents' cycle), so the channels are installed
# from here, in every process that loads the notifications (the API, a build).
_install_memory_conflict_notices()

__all__ = [
    "ChannelResult",
    "NotificationChannel",
    "NotificationService",
    "PRReadyNotification",
]

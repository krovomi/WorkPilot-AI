"""
Event-Driven Hooks System — Pre-configured Templates Library

Ready-made hooks: a person is told when something happens. Each action
in them does what it says (`hook_service._execute_action`).
"""

from .models import HookTemplate


def get_hook_templates() -> list[HookTemplate]:
    """Return all available hook templates."""
    return [
        HookTemplate(
            id="tpl-notify-build-failure",
            name="Notify on Build Failure",
            description="Send a Slack/notification when a build fails.",
            category="notification",
            icon="🔔",
            tags=["notification", "slack", "build", "failure", "alert"],
            popularity=87,
            triggers=[
                {
                    "id": "t1",
                    "type": "build_failed",
                    "conditions": [],
                    "config": {},
                    "position": {"x": 50, "y": 100},
                }
            ],
            actions=[
                {
                    "id": "a1",
                    "type": "send_notification",
                    "config": {
                        "title": "Build Failed",
                        "message": "Build failed — check logs for details.",
                        "type": "error",
                    },
                    "position": {"x": 350, "y": 50},
                },
                {
                    "id": "a2",
                    "type": "send_slack",
                    "config": {
                        "channel": "#builds",
                        "message": "🚨 Build failed: {{build_name}} — {{error_summary}}",
                    },
                    "position": {"x": 350, "y": 180},
                },
            ],
            connections=[
                {
                    "source_id": "t1",
                    "target_id": "a1",
                    "source_handle": "output",
                    "target_handle": "input",
                    "condition": "always",
                },
                {
                    "source_id": "t1",
                    "target_id": "a2",
                    "source_handle": "output",
                    "target_handle": "input",
                    "condition": "always",
                },
            ],
        ),
        HookTemplate(
            id="tpl-notify-pr-opened",
            name="Notify on PR Opened",
            description="Send notifications when a new pull request is opened.",
            category="notification",
            icon="📬",
            tags=["notification", "pr", "github", "alert"],
            popularity=78,
            triggers=[
                {
                    "id": "t1",
                    "type": "pr_opened",
                    "conditions": [],
                    "config": {},
                    "position": {"x": 50, "y": 100},
                }
            ],
            actions=[
                {
                    "id": "a1",
                    "type": "send_notification",
                    "config": {
                        "title": "New PR Opened",
                        "message": "PR #{{pr_number}}: {{pr_title}} by {{pr_author}}",
                        "type": "info",
                    },
                    "position": {"x": 350, "y": 100},
                }
            ],
            connections=[
                {
                    "source_id": "t1",
                    "target_id": "a1",
                    "source_handle": "output",
                    "target_handle": "input",
                    "condition": "always",
                },
            ],
        ),
        HookTemplate(
            id="tpl-announce-pr-ready",
            name="Announce PR Ready on Channels",
            description=(
                "When a task is completed and its PR is created, announce it on "
                "Microsoft Teams, Slack and/or Discord with all PR details "
                "(task, branch, link). Remove the channels you don't use; each "
                "action takes its webhook URL from the project settings "
                "(Notifications section) or from config['url']."
            ),
            category="notification",
            icon="📣",
            tags=["notification", "pr", "teams", "slack", "discord", "task-done"],
            popularity=90,
            triggers=[
                {
                    "id": "t1",
                    "type": "pr_opened",
                    "conditions": [],
                    "config": {},
                    "position": {"x": 50, "y": 150},
                }
            ],
            # No config["message"]: each action sends the rich per-channel PR
            # card built from the event data (task, branch, PR link, ...).
            actions=[
                {
                    "id": "a1",
                    "type": "send_teams",
                    "config": {},
                    "position": {"x": 350, "y": 50},
                },
                {
                    "id": "a2",
                    "type": "send_slack",
                    "config": {},
                    "position": {"x": 350, "y": 150},
                },
                {
                    "id": "a3",
                    "type": "send_discord",
                    "config": {},
                    "position": {"x": 350, "y": 250},
                },
            ],
            connections=[
                {
                    "source_id": "t1",
                    "target_id": "a1",
                    "source_handle": "output",
                    "target_handle": "input",
                    "condition": "always",
                },
                {
                    "source_id": "t1",
                    "target_id": "a2",
                    "source_handle": "output",
                    "target_handle": "input",
                    "condition": "always",
                },
                {
                    "source_id": "t1",
                    "target_id": "a3",
                    "source_handle": "output",
                    "target_handle": "input",
                    "condition": "always",
                },
            ],
        ),
        HookTemplate(
            id="tpl-dependency-update-alert",
            name="Dependency Update Alert",
            description="Alert when outdated or vulnerable dependencies are detected.",
            category="notification",
            icon="📦",
            tags=["dependency", "security", "update", "alert"],
            popularity=75,
            triggers=[
                {
                    "id": "t1",
                    "type": "dependency_outdated",
                    "conditions": [],
                    "config": {"check_interval_hours": 24},
                    "position": {"x": 50, "y": 100},
                }
            ],
            actions=[
                {
                    "id": "a1",
                    "type": "send_notification",
                    "config": {
                        "title": "Dependency Alert",
                        "message": "{{count}} outdated dependencies detected. {{critical_count}} have security vulnerabilities.",
                        "type": "warning",
                    },
                    "position": {"x": 350, "y": 50},
                },
            ],
            connections=[
                {
                    "source_id": "t1",
                    "target_id": "a1",
                    "source_handle": "output",
                    "target_handle": "input",
                    "condition": "always",
                },
            ],
        ),
    ]


def get_templates_by_category() -> dict[str, list[HookTemplate]]:
    """Return templates grouped by category."""
    result: dict[str, list[HookTemplate]] = {}
    for tpl in get_hook_templates():
        result.setdefault(tpl.category, []).append(tpl)
    return result


def get_template_by_id(template_id: str) -> HookTemplate | None:
    """Return a template by its ID."""
    for tpl in get_hook_templates():
        if tpl.id == template_id:
            return tpl
    return None

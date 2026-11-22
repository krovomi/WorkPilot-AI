"""A memory conflict queued by a sync, on the project's channels (#352).

`brain.lifecycle.announce` decides *which* pairs to announce, once each;
this module is the port it calls, installed when the notifications are
imported (``brain`` may not import ``services``, which sits in the agents'
import cycle). It says them on the channels the project configured for
"PR ready", through `channels.post_json` and its SSRF guard: no other way out.

Off unless the project asks: ``WORKPILOT_MEMORY_CONFLICT_NOTIFY=true`` in the
process environment or the project's ``.workpilot/.env`` (the switch in
Settings → Notifications). A project under the strict offline policy never
sends one: the notes are the project's knowledge, and a webhook is a cloud.

What it receives is already cleaned (`announce.notice_of`): titles and
previews a teammate wrote, with nothing that mentions anyone, and authors'
names only. It adds no text of its own beyond the fixed sentences below.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

from offline_policy import airgap_status

from .channels import _get_app_language, build_text_payload, post_json
from .models import NotificationChannel
from .service import NotificationService, project_env_vars

logger = logging.getLogger(__name__)

__all__ = ["NOTIFY_ENV", "ChannelAnnouncer", "install", "render"]

NOTIFY_ENV = "WORKPILOT_MEMORY_CONFLICT_NOTIFY"
_LISTED = 3

_STRINGS = {
    "en": {
        "head": "⚖️ {project}: {count} memory conflict(s) to settle",
        "pair": "• Two {kind} notes disagree ({signal}){escalated}",
        "escalated": ", contradicted again after a decision: a maintainer settles it",
        "side": "  {label}: {title}{text}{by}",
        "title": "“{title}” ",
        "by": " (by {names})",
        "withheld": "(text withheld: it reads as instructions)",
        "more": "…and {count} more.",
        "where": "Settle them in WorkPilot: Context → Lifecycle.",
        "kind": {"gotcha": "gotcha", "pattern": "pattern", "note": "memory"},
        "signal": {
            "value": "two values",
            "recommendation": "two recommendations",
            "negation": "do / do not",
            "textual": "edited on two machines",
            "reopened": "a decision taken back",
        },
    },
    "fr": {
        "head": "⚖️ {project} : {count} conflit(s) de mémoire à trancher",
        "pair": "• Deux notes ({kind}) se contredisent ({signal}){escalated}",
        "escalated": ", de nouveau après une décision : un mainteneur tranche",
        "side": "  {label} : {title}{text}{by}",
        "title": "« {title} » ",
        "by": " (par {names})",
        "withheld": "(texte retenu : il se lit comme des instructions)",
        "more": "…et {count} de plus.",
        "where": "À trancher dans WorkPilot : Contexte → Cycle de vie.",
        "kind": {"gotcha": "piège", "pattern": "convention", "note": "mémoire"},
        "signal": {
            "value": "deux valeurs",
            "recommendation": "deux recommandations",
            "negation": "faire / ne pas faire",
            "textual": "modifiée sur deux machines",
            "reopened": "une décision reprise",
        },
    },
}


def _strings() -> dict:
    return _STRINGS.get(_get_app_language(), _STRINGS["en"])


def _side(s: dict, label: str, side: dict) -> str:
    names = ", ".join(side.get("authors") or [])
    text = s["withheld"] if side.get("withheld") else side.get("text") or ""
    return (
        s["side"]
        .format(
            label=label,
            title=s["title"].format(title=side["title"]) if side.get("title") else "",
            text=text,
            by=s["by"].format(names=names) if names else "",
        )
        .rstrip()
    )


def render(project: str, notices: list[dict]) -> str:
    """The message, in the app's language; at most three pairs spelled out."""
    s = _strings()
    lines = [s["head"].format(project=project, count=len(notices))]
    for notice in notices[:_LISTED]:
        lines.append(
            s["pair"].format(
                kind=s["kind"].get(notice.get("kind"), s["kind"]["note"]),
                signal=s["signal"].get(notice.get("signal"), s["signal"]["textual"]),
                escalated=s["escalated"] if notice.get("escalated") else "",
            )
        )
        lines.append(_side(s, "A", notice.get("a") or {}))
        lines.append(_side(s, "B", notice.get("b") or {}))
    if len(notices) > _LISTED:
        lines.append(s["more"].format(count=len(notices) - _LISTED))
    lines.append(s["where"])
    return "\n".join(lines)


def _payload(
    channel: NotificationChannel, text: str, project: str, notices: list[dict]
) -> dict:
    if channel == NotificationChannel.WEBHOOK:
        return {
            "event": "memory_conflict",
            "project": project,
            "conflicts": notices,
            "message": text,
        }
    payload = build_text_payload(channel, text)
    if channel == NotificationChannel.DISCORD:
        # A teammate's words never ping a channel, whatever slipped through.
        payload["allowed_mentions"] = {"parse": []}
    return payload


class ChannelAnnouncer:
    """`brain.lifecycle.announce.Announcer` on the project's channels."""

    def enabled(self, project_dir: Path) -> bool:
        raw = os.environ.get(NOTIFY_ENV, "").strip()
        if not raw:
            raw = project_env_vars(project_dir).get(NOTIFY_ENV, "").strip()
        if raw.lower() != "true":
            return False
        try:
            if airgap_status(project_dir)["airgapStrict"]:
                return False
        except (OSError, ValueError):
            # An unreadable policy is not a permission to go out.
            return False
        return NotificationService.from_env(project_dir).is_configured

    def send(self, project_dir: Path, project: str, notices: list[dict]) -> bool:
        service = NotificationService.from_env(project_dir)
        text = render(project, notices)
        delivered = False
        for config in service.channels:
            # `post_json` validates the URL and never raises.
            ok, _code, error = post_json(
                config.webhook_url, _payload(config.channel, text, project, notices)
            )
            if not ok:
                logger.warning(
                    "[Notifications] memory conflict notice on %s failed: %s",
                    config.channel.value,
                    error,
                )
            delivered = delivered or ok
        return delivered


def install() -> None:
    """Make every later brain sweep of this process use the channels."""
    from brain.lifecycle import announce

    announce.install(ChannelAnnouncer())

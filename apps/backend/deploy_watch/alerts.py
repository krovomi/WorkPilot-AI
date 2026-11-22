"""Tell the team a deployment went bad: Slack, PagerDuty, e-mail (#366).

At the end of a watch with a warning or critical verdict, every channel the
project's CI/CD settings configure gets the same facts the app's own
notification carries: the verdict, the rollback, the revert PR, the
migrations, the worst metrics. A warning goes to Slack and e-mail; a critical
verdict also pages the on-call person through PagerDuty, the more so when the
rollback did not start (that escalation is in the event's text).

Facts of the watch's state only: no model text, no URL other than the revert
PR and the last good run, no token. The channels, their URLs and keys come
from the settings, never from a file of the repository; a webhook URL and a
routing key are secrets and are never logged. Under strict offline mode only
a Slack-compatible webhook or an SMTP server on the machine or a private
address is used; PagerDuty is never called.
"""

from __future__ import annotations

import json
import re
import smtplib
import ssl
import urllib.request
from collections.abc import Callable
from email.message import EmailMessage

from .collectors import Fetch, default_fetch
from .net import is_local_host, valid_url

PAGERDUTY_HOSTS = {
    "us": "https://events.pagerduty.com/v2/enqueue",
    "eu": "https://events.eu.pagerduty.com/v2/enqueue",
}
_ROUTING_KEY = re.compile(r"^[A-Za-z0-9]{32}$")
_EMAIL = re.compile(r"^[^@\s,<>\"]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$")
_HOST = re.compile(r"^[A-Za-z0-9.-]{1,253}$|^\[[0-9A-Fa-f:.]{2,45}\]$")
MAX_RECIPIENTS = 10
MAX_METRIC_LINES = 5
SMTP_TIMEOUT = 15

_WORDS = {
    "en": {
        "critical": "Deployment critical: {project}",
        "warning": "Deployment degraded: {project}",
        "critical_body": "Run {run}: two critical samples in a row after the deployment.",
        "warning_body": "Run {run}: the metrics got worse during the watch window.",
        "rollback": {
            "proposed": "A rollback is proposed on the CI/CD page.",
            "started": "The rollback started.",
            "failed": "The rollback could not start: roll back by hand now.",
            "blocked_migrations": "Automatic rollback blocked by a database migration: roll back by hand.",
            "manual": "Roll back by hand.",
        },
        "last_good": "Last good run: {url}",
        "revert_opened": "Revert PR: {url}",
        "revert_missed": "The revert PR could not be opened.",
        "migrations": "Database migrations in the change: {files}.",
        "health": "Health check failed {failed} of {checks} times.",
        "metric": "{name}: {baseline} before, {worst} at worst ({change} %).",
    },
    "fr": {
        "critical": "Déploiement critique : {project}",
        "warning": "Déploiement dégradé : {project}",
        "critical_body": "Exécution {run} : deux mesures critiques d'affilée après le déploiement.",
        "warning_body": "Exécution {run} : les métriques se sont dégradées pendant la fenêtre de surveillance.",
        "rollback": {
            "proposed": "Un rollback est proposé sur la page CI/CD.",
            "started": "Le rollback a démarré.",
            "failed": "Le rollback n'a pas pu démarrer : rollback à faire à la main maintenant.",
            "blocked_migrations": "Rollback automatique bloqué par une migration de base de données : rollback à la main.",
            "manual": "Rollback à faire à la main.",
        },
        "last_good": "Dernière bonne exécution : {url}",
        "revert_opened": "PR de revert : {url}",
        "revert_missed": "La PR de revert n'a pas pu être ouverte.",
        "migrations": "Migrations de base de données dans le changement : {files}.",
        "health": "Health check en échec {failed} fois sur {checks}.",
        "metric": "{name} : {baseline} avant, {worst} au pire ({change} %).",
    },
}

# (host, port, implicit TLS, TLS context) -> an object with smtplib.SMTP's API.
SmtpFactory = Callable[[str, int, bool, ssl.SSLContext], smtplib.SMTP]


def _default_smtp(
    host: str, port: int, implicit_tls: bool, context: ssl.SSLContext
) -> smtplib.SMTP:
    if implicit_tls:
        return smtplib.SMTP_SSL(host, port, timeout=SMTP_TIMEOUT, context=context)
    return smtplib.SMTP(host, port, timeout=SMTP_TIMEOUT)


def _https(value: object) -> str:
    return (
        value
        if isinstance(value, str) and valid_url(value) and value.startswith("https://")
        else ""
    )


def _number(value: object) -> str:
    return (
        f"{value:g}"
        if isinstance(value, int | float) and not isinstance(value, bool)
        else "?"
    )


def alert_text(state: dict, project: str, language: str) -> tuple[str, list[str]]:
    """(title, lines) of a warning or critical watch, in the app's language."""
    words = _WORDS["fr" if language == "fr" else "en"]
    critical = state.get("verdict") == "critical"
    run = str(state.get("run_id") or "")
    title = words["critical" if critical else "warning"].format(project=project)
    lines = [words["critical_body" if critical else "warning_body"].format(run=run)]
    rollback = state.get("rollback")
    if rollback in words["rollback"]:
        lines.append(words["rollback"][rollback])
    plan = state.get("plan") if isinstance(state.get("plan"), dict) else {}
    if rollback in ("manual", "failed", "blocked_migrations") and _https(
        plan.get("target_url")
    ):
        lines.append(words["last_good"].format(url=plan["target_url"]))
    revert = (
        state.get("revert_pr") if isinstance(state.get("revert_pr"), dict) else None
    )
    if revert:
        opened = revert.get("status") in ("opened", "exists")
        if opened and _https(revert.get("url")):
            lines.append(words["revert_opened"].format(url=revert["url"]))
        elif not opened:
            lines.append(words["revert_missed"])
    migrations = state.get("migrations")
    if isinstance(migrations, list) and migrations:
        lines.append(
            words["migrations"].format(
                files=", ".join(str(m)[:120] for m in migrations[:5])
            )
        )
    summary = (state.get("incident") or {}).get("summary") or {}
    health = summary.get("health") or {}
    if isinstance(health.get("failed"), int) and health["failed"] > 0:
        lines.append(
            words["health"].format(
                failed=health["failed"], checks=health.get("checks", "?")
            )
        )
    rows = [m for m in summary.get("metrics") or [] if isinstance(m, dict)]
    for row in [m for m in rows if m.get("level") in ("warning", "critical")][
        :MAX_METRIC_LINES
    ]:
        lines.append(
            words["metric"].format(
                name=str(row.get("name") or "")[:60],
                baseline=_number(row.get("baseline")),
                worst=_number(row.get("worst")),
                change=_number(row.get("worst_change_pct")),
            )
        )
    return title, lines


def _slack_escape(text: str) -> str:
    # A metric name is the repository's text: no mention, no link markup.
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _post_json(fetch: Fetch, url: str, payload: dict) -> bool:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={"Content-Type": "application/json", "User-Agent": "WorkPilot"},
    )
    try:
        status, _body = fetch(request)
    except (OSError, ValueError):
        return False
    return 200 <= status < 300


def _slack(
    env: dict, offline: bool, title: str, lines: list[str], fetch: Fetch
) -> str | None:
    url = str(env.get("CICD_ALERT_SLACK_WEBHOOK_URL") or "").strip()
    if not url:
        return None
    if not valid_url(url) or not (url.startswith("https://") or is_local_host(url)):
        return "invalid"
    if offline and not is_local_host(url):
        return "offline"
    text = "\n".join(_slack_escape(line) for line in [f"*{title}*", *lines])
    return "sent" if _post_json(fetch, url, {"text": text}) else "failed"


def _pagerduty(
    env: dict, offline: bool, state: dict, title: str, lines: list[str], fetch: Fetch
) -> str | None:
    key = str(env.get("CICD_ALERT_PAGERDUTY_ROUTING_KEY") or "").strip()
    if not key or state.get("verdict") != "critical":
        return None
    region = str(env.get("CICD_ALERT_PAGERDUTY_REGION") or "us").strip().lower()
    if not _ROUTING_KEY.match(key) or region not in PAGERDUTY_HOSTS:
        return "invalid"
    if offline:
        return "offline"
    payload: dict = {
        "routing_key": key,
        "event_action": "trigger",
        # One incident per watched run, however often it is sent.
        "dedup_key": f"workpilot-deploy-{state.get('run_id')}",
        "payload": {
            "summary": title[:1024],
            "source": "WorkPilot",
            "severity": "critical",
            "component": "deployment",
            "custom_details": {
                "details": lines,
                "rollback": state.get("rollback") or "",
            },
        },
    }
    revert = state.get("revert_pr") if isinstance(state.get("revert_pr"), dict) else {}
    if _https(revert.get("url")):
        payload["links"] = [{"href": revert["url"], "text": "Revert PR"}]
    return "sent" if _post_json(fetch, PAGERDUTY_HOSTS[region], payload) else "failed"


def _recipients(raw: str) -> list[str] | None:
    addresses = [a.strip() for a in raw.split(",") if a.strip()]
    if not addresses or len(addresses) > MAX_RECIPIENTS:
        return None
    return addresses if all(_EMAIL.match(a) for a in addresses) else None


def _email(
    env: dict, offline: bool, title: str, lines: list[str], smtp: SmtpFactory
) -> str | None:
    host = str(env.get("CICD_ALERT_SMTP_HOST") or "").strip()
    to = str(env.get("CICD_ALERT_EMAIL_TO") or "")
    if not (host or to.strip()):
        return None
    recipients = _recipients(to)
    sender = str(env.get("CICD_ALERT_EMAIL_FROM") or "").strip()
    port_text = str(env.get("CICD_ALERT_SMTP_PORT") or "587").strip()
    if not (
        recipients
        and _EMAIL.match(sender)
        and _HOST.match(host)
        and port_text.isdigit()
        and 0 < int(port_text) < 65536
    ):
        return "invalid"
    local = is_local_host(f"smtp://{host}")
    if offline and not local:
        return "offline"
    message = EmailMessage()
    message["Subject"] = title
    message["From"] = sender
    message["To"] = ", ".join(recipients)
    message.set_content("\n".join(lines))
    port = int(port_text)
    context = ssl.create_default_context()
    user = str(env.get("CICD_ALERT_SMTP_USER") or "")
    password = str(env.get("CICD_ALERT_SMTP_PASSWORD") or "")
    try:
        with smtp(host, port, port == 465, context) as client:
            if port != 465:
                client.ehlo()
                if client.has_extn("starttls"):
                    client.starttls(context=context)
                    client.ehlo()
                elif not local:
                    # A password or a report in clear over the network: no.
                    return "failed"
            if user and password:
                client.login(user, password)
            client.send_message(message)
    except (OSError, smtplib.SMTPException):
        return "failed"
    return "sent"


def send_alerts(
    state: dict,
    env: dict,
    *,
    project: str,
    language: str,
    offline: bool,
    fetch: Fetch = default_fetch,
    smtp: SmtpFactory = _default_smtp,
) -> dict[str, str]:
    """Each configured channel -> sent | failed | invalid | offline."""
    if state.get("verdict") not in ("warning", "critical"):
        return {}
    title, lines = alert_text(state, project, language)
    outcomes = {
        "slack": _slack(env, offline, title, lines, fetch),
        "pagerduty": _pagerduty(env, offline, state, title, lines, fetch),
        "email": _email(env, offline, title, lines, smtp),
    }
    return {name: outcome for name, outcome in outcomes.items() if outcome}

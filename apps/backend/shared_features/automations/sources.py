"""The events a server rule listens to: the desktop's sources, read on the
server.

``apps/frontend/src/main/automations/sources.ts`` reads GitHub issues and pull
requests with the project's token, the base branch's pipeline through the CI
provider and the clock. Here the forge is the project's own, GitHub or a
GitLab instance the operator named, read with the token of the person who
saved the rule (``forge_api.py``), and the pipeline is that forge's
(GitHub Actions, GitLab CI). A source that cannot be read raises, with the
reason; it never answers "nothing new" in its place.

What an issue says is data (S2): its title and body pass through
``security.untrusted`` and the body enters the card fenced as untrusted
content. Nothing read from a forge chooses a tool, a command, a path or a
right: an event carries numbers, a fixed key and text for the card.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import TYPE_CHECKING, Any, Protocol

from .rules import created_at

if TYPE_CHECKING:
    from collections.abc import Callable

ISSUES_PER_PASS = 50
EVENT_PAGES = 5
MAX_LABELS = 50
MAX_FAILED_STEPS = 20


class SourceError(Exception):
    """A source that cannot be read, for a reason the panel can name."""

    def __init__(self, reason: str, message: str) -> None:
        super().__init__(message)
        self.reason = reason


class Forge(Protocol):
    forge: str
    slug: str

    async def get(self, path: str, params: dict[str, str] | None = None) -> Any: ...

    async def me(self) -> str: ...


@dataclass
class Event:
    """An event that may become a card. ``key`` is what dedups it."""

    key: str
    #: One line for the activity log: ``#12``, ``CI #418 on main``, ``2026-10-26``.
    subject: str
    title: str
    description: str
    url: str | None = None
    #: ``{"forge", "number", "url", "labels"}`` for an issue.
    issue: dict[str, Any] | None = None
    #: ``{"number", "url"}`` for a pull or merge request to review.
    pr: dict[str, Any] | None = None


@dataclass
class SourceResult:
    events: list[Event] = field(default_factory=list)
    #: Events that are not this rule's: ``(key, subject, reason)``.
    ignored: list[tuple[str, str, str]] = field(default_factory=list)
    #: The CI source saw a green run: the red streak is over.
    green: bool = False


def one_line(value: Any, limit: int = 200) -> str:
    return " ".join(str(value or "").split())[:limit]


def untrusted_title(value: Any) -> str:
    from security.untrusted import clean_untrusted

    return one_line(clean_untrusted(str(value or ""), kind="issue_title").text)


def untrusted_body(value: Any, source: str) -> str:
    from security.untrusted import quote_untrusted

    text = str(value or "").strip()
    if not text:
        return "No description provided."
    return quote_untrusted(text, kind="issue_body", source=source)


def _labels(raw: Any) -> list[str]:
    names = [
        one_line(label if isinstance(label, str) else (label or {}).get("name"))
        for label in (raw if isinstance(raw, list) else [])[:MAX_LABELS]
        if isinstance(label, str | dict)
    ]
    return [name for name in names if name]


def _number(value: Any) -> int | None:
    return (
        value
        if isinstance(value, int) and not isinstance(value, bool) and value > 0
        else None
    )


def _url(value: Any) -> str | None:
    return value if isinstance(value, str) and value.startswith("https://") else None


def _when(value: Any) -> float | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def issue_key(forge: Forge, number: int) -> str:
    return f"{forge.forge}-issue:{forge.slug.lower()}#{number}"


def pr_key(forge: Forge, number: int) -> str:
    kind = "pr" if forge.forge == "github" else "mr"
    return f"{forge.forge}-{kind}:{forge.slug.lower()}#{number}"


async def _labeled_since(forge: Forge, number: int, label: str, since: float) -> bool:
    """Whether ``label`` was put on the issue at or after ``since``."""
    wanted = label.lower()
    path = (
        f"/issues/{number}/events"
        if forge.forge == "github"
        else f"/issues/{number}/resource_label_events"
    )
    for page in range(1, EVENT_PAGES + 1):
        events = await forge.get(path, {"per_page": "100", "page": str(page)})
        if not isinstance(events, list):
            return False
        for event in events:
            if not isinstance(event, dict):
                continue
            added = (
                event.get("event") == "labeled"
                if forge.forge == "github"
                else event.get("action") == "add"
            )
            name = (event.get("label") or {}).get("name")
            moment = _when(event.get("created_at"))
            if (
                added
                and isinstance(name, str)
                and name.lower() == wanted
                and moment is not None
                and moment >= since
            ):
                return True
        if len(events) < 100:
            return False
    return False


async def issue_labeled_events(
    rule: dict[str, Any], forge: Forge, already_seen: Callable[[str], bool]
) -> SourceResult:
    """Open issues that received the rule's label after the rule was created.
    An issue that carried the label before is ignored: turning a rule on is
    not a request to import the backlog."""
    since = created_at(rule).timestamp()
    label = rule["trigger"]["label"]
    if forge.forge == "github":
        params = {
            "state": "open",
            "labels": label,
            "since": rule["createdAt"],
            "sort": "created",
            "direction": "asc",
            "per_page": str(ISSUES_PER_PASS),
        }
    else:
        params = {
            "state": "opened",
            "labels": label,
            "updated_after": rule["createdAt"],
            "order_by": "created_at",
            "sort": "asc",
            "per_page": str(ISSUES_PER_PASS),
        }
    issues = await forge.get("/issues", params)
    if not isinstance(issues, list):
        raise SourceError(
            "source_failed", "The forge answered the issue list with something else"
        )
    result = SourceResult()
    forge_name = "GitHub" if forge.forge == "github" else "GitLab"
    for issue in issues:
        # GitHub lists pull requests among the issues, with this key.
        if not isinstance(issue, dict) or issue.get("pull_request") is not None:
            continue
        number = _number(issue.get("number" if forge.forge == "github" else "iid"))
        if number is None:
            continue
        key = issue_key(forge, number)
        if already_seen(key):
            continue
        subject = f"#{number}"
        if not await _labeled_since(forge, number, label, since):
            result.ignored.append((key, subject, "label_predates_rule"))
            continue
        url = _url(issue.get("html_url" if forge.forge == "github" else "web_url"))
        title = untrusted_title(issue.get("title")) or subject
        labels = _labels(issue.get("labels"))
        body = issue.get("body" if forge.forge == "github" else "description")
        link = f"[#{number}]({url})" if url else f"#{number}"
        description = (
            f"# {title}\n\n**{forge_name} Issue:** {link}\n"
            + (f"**Labels:** {', '.join(labels)}\n" if labels else "")
            + f"\n## Description\n\n{untrusted_body(body, url or key)}\n"
        )
        result.events.append(
            Event(
                key=key,
                subject=subject,
                title=title,
                description=description,
                url=url,
                issue={
                    "forge": forge.forge,
                    "number": number,
                    "url": url,
                    "labels": labels,
                },
            )
        )
    return result


def _is_bot(author: dict[str, Any], forge: Forge) -> bool:
    if forge.forge == "github":
        return author.get("type") == "Bot"
    username = str(author.get("username") or "").lower()
    # GitLab's project and group access tokens act as `project_<id>_bot_…` users.
    return author.get("bot") is True or "_bot" in username


async def pr_opened_events(
    rule: dict[str, Any], forge: Forge, already_seen: Callable[[str], bool]
) -> SourceResult:
    """Open pull (merge) requests another person opened after the rule was
    created, oldest first. The token owner's own and bots' are ignored, and
    remembered as such; a draft is not an event yet. When the forge does not
    say whose token this is, the source fails rather than review the
    person's own work."""
    since = created_at(rule).timestamp()
    base = rule["trigger"].get("base")
    if forge.forge == "github":
        params = {
            "state": "open",
            "sort": "created",
            "direction": "desc",
            "per_page": str(ISSUES_PER_PASS),
        }
        if base:
            params["base"] = base
        pulls = await forge.get("/pulls", params)
    else:
        params = {
            "state": "opened",
            "order_by": "created_at",
            "sort": "desc",
            "per_page": str(ISSUES_PER_PASS),
        }
        if base:
            params["target_branch"] = base
        pulls = await forge.get("/merge_requests", params)
    if not isinstance(pulls, list):
        raise SourceError(
            "source_failed", "The forge answered the request list with something else"
        )
    candidates = []
    for pull in pulls:
        if not isinstance(pull, dict):
            continue
        number = _number(pull.get("number" if forge.forge == "github" else "iid"))
        moment = _when(pull.get("created_at"))
        draft = pull.get("draft") or pull.get("work_in_progress")
        if (
            number is None
            or draft
            or moment is None
            or moment < since
            or already_seen(pr_key(forge, number))
        ):
            continue
        candidates.append((number, pull))
    candidates.reverse()
    result = SourceResult()
    if not candidates:
        return result

    login = await forge.me()
    word = "PR" if forge.forge == "github" else "MR"
    for number, pull in candidates:
        key = pr_key(forge, number)
        subject = f"{word} #{number}"
        author = pull.get("user" if forge.forge == "github" else "author")
        author = author if isinstance(author, dict) else {}
        name = author.get("login" if forge.forge == "github" else "username")
        if not isinstance(name, str) or not name or _is_bot(author, forge):
            result.ignored.append((key, subject, "bot_author"))
            continue
        if name.lower() == login:
            result.ignored.append((key, subject, "own_pr"))
            continue
        url = _url(pull.get("html_url" if forge.forge == "github" else "web_url"))
        # Only the number goes on: the request's title and body reach the
        # reviewer through its own fetch, as untrusted content.
        result.events.append(
            Event(
                key=key,
                subject=subject,
                title=subject,
                description="",
                url=url,
                pr={"number": number, "url": url},
            )
        )
    return result


#: The CI provider ids of the desktop (``ci-pipeline-providers``), for the keys.
CI_PROVIDERS = {"github": "github-actions", "gitlab": "gitlab-ci"}
CI_LABELS = {"github": "GitHub Actions", "gitlab": "GitLab CI"}


async def _latest_run(forge: Forge, branch: str) -> dict[str, Any] | None:
    """The branch's latest run, as ``{id, number, name, url, state, finished}``."""
    if forge.forge == "github":
        body = await forge.get("/actions/runs", {"branch": branch, "per_page": "1"})
        runs = body.get("workflow_runs") if isinstance(body, dict) else None
        if not isinstance(runs, list):
            raise SourceError(
                "source_failed", "GitHub answered the run list with something else"
            )
        if not runs or not isinstance(runs[0], dict):
            return None
        run = runs[0]
        conclusion = run.get("conclusion")
        if run.get("status") != "completed":
            state = "running"
        elif conclusion == "success":
            state = "succeeded"
        elif conclusion in ("failure", "timed_out", "startup_failure"):
            state = "failed"
        else:
            state = "other"
        return {
            "id": _number(run.get("id")),
            "number": f"#{_number(run.get('run_number')) or ''}",
            "name": one_line(run.get("name"), 100) or CI_LABELS[forge.forge],
            "url": _url(run.get("html_url")),
            "state": state,
            "finished": one_line(run.get("updated_at"), 40),
        }
    body = await forge.get(
        "/pipelines",
        {"ref": branch, "per_page": "1", "order_by": "id", "sort": "desc"},
    )
    if not isinstance(body, list):
        raise SourceError(
            "source_failed", "GitLab answered the pipeline list with something else"
        )
    if not body or not isinstance(body[0], dict):
        return None
    run = body[0]
    status = run.get("status")
    state = {"success": "succeeded", "failed": "failed"}.get(
        str(status),
        "running"
        if status
        in ("created", "pending", "running", "preparing", "waiting_for_resource")
        else "other",
    )
    return {
        "id": _number(run.get("id")),
        "number": f"#{_number(run.get('iid')) or _number(run.get('id')) or ''}",
        "name": CI_LABELS[forge.forge],
        "url": _url(run.get("web_url")),
        "state": state,
        "finished": one_line(run.get("updated_at"), 40),
    }


async def _failed_steps(forge: Forge, run_id: int) -> list[str]:
    """The failed jobs of a run, as lines for the card; a bonus, never needed."""
    if forge.forge == "github":
        body = await forge.get(f"/actions/runs/{run_id}/jobs", {"per_page": "50"})
        jobs = body.get("jobs") if isinstance(body, dict) else None
    else:
        jobs = await forge.get(
            f"/pipelines/{run_id}/jobs", {"scope[]": "failed", "per_page": "50"}
        )
    lines: list[str] = []
    for job in jobs if isinstance(jobs, list) else []:
        if not isinstance(job, dict):
            continue
        if forge.forge == "github" and job.get("conclusion") != "failure":
            continue
        name = untrusted_title(job.get("name"))
        steps = [
            untrusted_title(step.get("name"))
            for step in job.get("steps") or []
            if isinstance(step, dict) and step.get("conclusion") == "failure"
        ]
        stage = untrusted_title(job.get("stage")) if forge.forge == "gitlab" else ""
        label = f"{stage}: {name}" if stage else name
        if label:
            lines.append(
                f"{label}"
                + (f" ({', '.join(s for s in steps if s)})" if any(steps) else "")
            )
        if len(lines) >= MAX_FAILED_STEPS:
            break
    return lines


async def ci_failed_events(
    rule: dict[str, Any], forge: Forge, branch: str
) -> SourceResult:
    """The branch's latest pipeline run, when it failed. A run still going is
    not an event yet, and a green one ends the streak."""
    run = await _latest_run(forge, branch)
    if run is None or run["id"] is None:
        return SourceResult()
    if run["state"] == "succeeded":
        return SourceResult(green=True)
    if run["state"] != "failed":
        return SourceResult()
    try:
        errors = await _failed_steps(forge, run["id"])
    except SourceError:
        # The run's state is known; its details are a bonus.
        errors = []
    provider = CI_PROVIDERS[forge.forge]
    label = CI_LABELS[forge.forge]
    name, reference = run["name"], run["number"]
    lines = "\n".join(f"- {line}" for line in errors)
    description = (
        f"# Fix CI on {branch}\n\n"
        f"The latest {label} run on `{branch}` failed.\n\n"
        f"- **Pipeline:** {name} {reference}\n"
        + (f"- **Run:** {run['url']}\n" if run["url"] else "")
        + (f"- **Finished:** {run['finished']}\n" if run["finished"] else "")
        + "\n## What failed\n\n"
        + (lines or "The provider did not say which step failed.")
        + f"\n\n## Done when\n\nThe pipeline on `{branch}` passes again. Fix the "
        "cause; do not skip, disable or loosen a test or a check.\n"
    )
    return SourceResult(
        events=[
            Event(
                key=f"ci:{provider}:{branch}:{run['id']}",
                subject=f"{name} {reference} on {branch}",
                title=f"Fix CI on {branch}: {name}",
                description=description,
                url=run["url"],
            )
        ]
    )


def local_date(now: datetime) -> str:
    return now.strftime("%Y-%m-%d")


def schedule_events(rule: dict[str, Any], now: datetime) -> SourceResult:
    """Today's slot, once its time has passed, in the server's local time. A
    rule created after today's time starts tomorrow, and a missed day is not
    made up."""
    trigger = rule["trigger"]
    # JavaScript's getDay(): 0 is Sunday.
    if (now.isoweekday() % 7) not in trigger["days"]:
        return SourceResult()
    hours, minutes = (int(part) for part in trigger["time"].split(":"))
    slot = now.replace(hour=hours, minute=minutes, second=0, microsecond=0)
    if now < slot or created_at(rule) > slot:
        return SourceResult()
    day = local_date(now)
    return SourceResult(
        events=[
            Event(
                key=f"schedule:{rule['id']}:{day}",
                subject=day,
                title=trigger["title"],
                description=trigger["prompt"],
            )
        ]
    )

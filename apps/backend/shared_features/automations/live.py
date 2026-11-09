"""What a pass does on the server: read the forge as the rule's owner, write
cards as *Automations*, start runs and reviews.

Each rule acts with the authority of the person who saved it last, its
owner, checked again at every pass and not only when the rule was saved: a
person who left the project, lost the member role, or lost
``task.write`` (``agent.execute`` for a rule that starts a build or a review)
stops their rules, which say why (``owner_not_allowed``). The forge is read
with the owner's own token; without one the rule says so
(``token_missing``). A card's author is the service account; a build the
rule starts runs as the service account too, so an agent reading an issue no
person looked at gets nobody's forge token. A review job is started as the
owner, like their click in the forge view: it needs their token to read the
request.
"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import HTTPException
from server.authz.engine import resolve_permissions
from server.authz.principal import Principal
from server.authz.scope import ProjectScope, load_project_scope
from server.db.models import AuditLog, Project, User
from server.forges import github_repo, gitlab_project
from server.services.events import emit_board_event
from server.services.secrets import SecretsVaultError, get_user_secret
from shared_board.cards import _index_row, _require_writer
from sqlalchemy.ext.asyncio import AsyncSession

from . import cards
from .forge_api import ForgeApi, github_api, gitlab_api
from .sources import (
    Event,
    SourceError,
    SourceResult,
    ci_failed_events,
    issue_labeled_events,
    pr_opened_events,
    prod_incident_events,
    schedule_events,
)


def needs_execute(rule: dict[str, Any]) -> bool:
    """Whether the rule starts agents: a build, or a review."""
    return rule["trigger"]["type"] == "pr_opened" or rule.get("draft") is False


async def owner_principal(
    db: AsyncSession, user_id: str | None, project: Project
) -> Principal | None:
    """The owner as the server would see them acting on this project now;
    None when they may no longer change its board."""
    user = await db.get(User, user_id) if user_id else None
    if user is None or not user.is_active:
        return None
    permissions, slug = await resolve_permissions(
        db, user_id=user.id, platform_role=user.role, org_id=project.org_id
    )
    principal = Principal(
        id=user.id,
        email=user.email,
        display_name=user.display_name,
        platform_role=user.role,
        org_id=project.org_id,
        org_role_slug=slug,
        permissions=permissions,
    )
    try:
        scope = await load_project_scope(db, principal, project.id)
        _require_writer(scope, principal)
    except HTTPException:
        return None
    return principal if principal.has("task.write") else None


class ServerDeps:
    """The pass's dependencies for one project, with one database session."""

    def __init__(
        self,
        db: AsyncSession,
        project: Project,
        owners: dict[str, str],
        now: datetime,
    ) -> None:
        self.db = db
        self.project = project
        self.owners = owners
        self._now = now
        self.root = Path(project.server_path)
        self.scope = ProjectScope(project.id, project.org_id, self.root, None)
        self._service: User | None = None

    def now(self) -> datetime:
        return self._now

    async def _service_account(self) -> User:
        if self._service is None:
            self._service = await cards.service_account(self.db)
        return self._service

    # -- the source --------------------------------------------------------

    def _guard_offline(self) -> None:
        from offline_policy import guard_cloud_client

        try:
            guard_cloud_client(self.root)
        except ValueError as e:
            raise SourceError("source_failed", str(e)) from None

    async def _forge(self, owner_id: str) -> ForgeApi:
        url = self.project.repo_url
        repo = github_repo(url)
        gitlab = None if repo else gitlab_project(url)
        if repo is None and gitlab is None:
            raise SourceError(
                "forge_not_connected", "This project is on neither GitHub nor GitLab"
            )
        forge = "github" if repo else "gitlab"
        name = "GitHub" if repo else "GitLab"
        try:
            token = await get_user_secret(self.db, owner_id, f"{forge}_token")
        except SecretsVaultError:
            raise SourceError("source_failed", "Tokens unavailable") from None
        if not token:
            raise SourceError(
                "token_missing", f"The rule's owner has no {name} token on the server"
            )
        self._guard_offline()
        if repo:
            return github_api(repo, token)
        host, path = gitlab  # type: ignore[misc]
        return gitlab_api(host, path, token)

    async def _sentry(self, owner_id: str, host: str) -> Any:
        """The owner's Sentry client, on a host the operator vouched for."""
        from regression_guardian.feed import FeedError, is_sentry_cloud
        from server.config import get_settings
        from shared_features.forge import send

        if not is_sentry_cloud(host) and host not in get_settings().sentry_hosts:
            raise SourceError(
                "source_failed",
                "This Sentry host is not in WORKPILOT_SENTRY_HOSTS",
            )
        try:
            token = await get_user_secret(self.db, owner_id, "sentry_token")
        except SecretsVaultError:
            raise SourceError("source_failed", "Tokens unavailable") from None
        if not token:
            return None
        self._guard_offline()
        headers = {"Authorization": f"Bearer {token}", "User-Agent": "WorkPilot-AI"}

        async def get(url: str, params: dict[str, str] | None) -> Any:
            try:
                answer = await send("GET", url, headers, params=params)
            except HTTPException as e:
                raise FeedError("source_failed", f"Sentry: {e.detail}") from None
            status = answer.get("status", 0)
            if not 200 <= status < 300:
                raise FeedError("source_failed", f"Sentry answered {status}")
            return answer.get("body")

        return get

    async def read_source(
        self, rule: dict[str, Any], ledger: dict[str, Any]
    ) -> SourceResult:
        owner = await owner_principal(
            self.db, self.owners.get(rule["id"]), self.project
        )
        if owner is None or (needs_execute(rule) and not owner.has("agent.execute")):
            raise SourceError(
                "owner_not_allowed",
                "The person who saved this rule may no longer run it on this project",
            )
        trigger = rule["trigger"]
        if trigger["type"] == "schedule":
            return schedule_events(rule, self._now)

        def seen(key: str) -> bool:
            return key in ledger["seen"]

        if trigger["type"] == "prod_incident":
            sentry = (
                await self._sentry(owner.id, trigger.get("host") or "sentry.io")
                if trigger.get("org")
                else None
            )
            return await prod_incident_events(rule, self.root, seen, sentry)
        forge = await self._forge(owner.id)

        if trigger["type"] == "issue_labeled":
            return await issue_labeled_events(rule, forge, seen)
        if trigger["type"] == "pr_opened":
            return await pr_opened_events(rule, forge, seen)
        branch = trigger.get("branch") or self.project.default_branch or "main"
        return await ci_failed_events(rule, forge, branch)

    # -- the board ---------------------------------------------------------

    async def create_card(self, rule: dict[str, Any], event: Event) -> str:
        from core.workspace.models import SpecNumberLockError

        author = await self._service_account()
        metadata = cards.card_metadata(
            rule, event, author, self.project.default_branch or ""
        )
        try:
            directory = cards.write_automation_card(self.root, rule, event, metadata)
        except SpecNumberLockError:
            raise SourceError(
                "card_failed", "Board busy, tried again next pass"
            ) from None
        row = await _index_row(self.db, self.scope, directory.name)
        if row is not None and row.created_by is None:
            row.created_by = author.id
        self.db.add(
            AuditLog(
                user_id=author.id,
                org_id=self.project.org_id,
                project_id=self.project.id,
                action="automation.card.created",
                payload={
                    "rule": rule["id"],
                    "spec": directory.name,
                    "event": event.key,
                },
            )
        )
        await self.db.commit()
        emit_board_event(
            self.project.id, "spec_created", {"spec": directory.name, "by": author.id}
        )
        return directory.name

    async def start_card(self, rule: dict[str, Any], card_id: str) -> None:
        from server.services.run_manager import get_run_manager

        author = await self._service_account()
        row = await _index_row(self.db, self.scope, card_id)
        if row is None:
            raise SourceError("not_started", "The card is not in the board's index")
        run = await get_run_manager().start_run(
            spec=row,
            project_id=self.project.id,
            server_path=self.project.server_path,
            phase="spec",
            user_id=author.id,
            org_id=self.project.org_id,
        )
        self.db.add(
            AuditLog(
                user_id=author.id,
                org_id=self.project.org_id,
                project_id=self.project.id,
                action="spec.run.started",
                payload={
                    "spec": card_id,
                    "phase": "spec",
                    "run_id": run.id,
                    "rule": rule["id"],
                },
            )
        )
        await self.db.commit()

    def is_card_open(self, card_id: str) -> bool:
        from board_mcp.server import card_dir, summary
        from shared_board.listing import card_source

        directory = card_dir(self.root, card_id)
        if directory is None:
            return False
        source = card_source(self.root.resolve(), directory)
        if summary(source)["column"] == "done":
            return False
        metadata = cards.read_metadata(directory)
        return not metadata.get("archivedAt")

    def issue_numbers_on_board(self, forge: str) -> set[int]:
        return cards.issues_on_board(self.root, forge)

    # -- reviews -----------------------------------------------------------

    def _reviews(self) -> Any:
        from shared_features.forge_review import GITHUB, GITLAB

        return GITHUB if github_repo(self.project.repo_url) else GITLAB

    def has_pr_review(self, rule: dict[str, Any], number: int) -> bool:
        from server.services.project_jobs import get_project_jobs

        reviews = self._reviews()
        saved = self.root / reviews.forge.review_dir / f"review_{number}.json"
        running = get_project_jobs().running_job(self.project.id, reviews._slot(number))
        return saved.is_file() or running is not None

    async def start_pr_review(self, rule: dict[str, Any], number: int) -> None:
        from server.services.project_jobs import get_project_jobs
        from shared_features.forge_review import ReviewJob

        reviews = self._reviews()
        target = await reviews.forge.target(self.db, self.scope)
        await get_project_jobs().start(
            project_id=self.project.id,
            org_id=self.project.org_id,
            server_path=self.project.server_path,
            feature=reviews.forge.feature,
            runner=reviews.forge.runner,
            args=reviews.forge.args(target, ReviewJob(number=number)),
            user_id=self.owners[rule["id"]],
            slot=reviews._slot(number),
            project_flag=reviews.forge.project_flag,
        )

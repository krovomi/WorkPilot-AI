"""The task's captures in its pull request body, on every forge.

`pr_captures` prepares the copies that may leave the machine and lists them in
`<spec>/captures/publication.json`; this package puts them where the pull
request can show them and writes the "Captures" section of its body:

| Forge | Where the images go |
|---|---|
| GitHub, GitLab, Bitbucket | the captures branch of the same repository (`branch.py`) |
| Azure DevOps | the pull request's own attachments |

`sync_pr_captures` is called once the pull request exists
(`WorktreePRMixin.push_and_create_pr`) and again whenever the captures change
(`runners/pr_captures_runner.py sync`): the section is replaced, never added
twice, and removed when nothing is to be shown any more. What it did is written
to `<spec>/captures/pr-sync.json` for the app. It never raises and never fails
the pull request: a refusal is a status and a short reason code.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
from collections.abc import Callable, Mapping
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from docintel.visual_qa import CAPTURES_DIR
from foundation.git_executable import run_git
from pr_captures.approval import approved_signatures
from pr_captures.publication import PUBLISHED_DIR, load_publication
from pr_captures.section import (
    START,
    hosted_files,
    render_section,
    replace_section,
)
from pr_captures.settings import load_settings

from .branch import BranchStore, spec_key
from .forges import ATTACHMENT_PREFIX, AzureAttachments, body_for, run_cli
from .refs import PrRef, parse_pr_url

__all__ = [
    "SYNC_FILE",
    "load_sync",
    "sync_after_pr",
    "sync_pr_captures",
    "task_spec_dir",
]

logger = logging.getLogger(__name__)

SYNC_FILE = "pr-sync.json"
BRANCH_FORGES = ("github", "gitlab", "bitbucket")


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def load_sync(spec_dir: Path | str) -> dict | None:
    """What the last sync did, or None."""
    try:
        data = json.loads(
            (Path(spec_dir) / CAPTURES_DIR / SYNC_FILE).read_text(encoding="utf-8")
        )
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _record(spec: Path, payload: dict) -> dict:
    target = spec / CAPTURES_DIR / SYNC_FILE
    if not target.parent.is_dir():
        # A task without captures gets no file of ours.
        return payload
    try:
        partial = target.with_name(f".{target.name}.partial")
        partial.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        os.replace(partial, target)
    except OSError as exc:
        logger.debug("captures sync: could not record: %s", exc)
    return payload


def _local_files(spec: Path, names: list[str]) -> dict[str, Path]:
    """The published copies, each checked to be a PNG of `captures/published/`."""
    root = (spec / CAPTURES_DIR / PUBLISHED_DIR).resolve()
    found: dict[str, Path] = {}
    for name in names:
        try:
            local = (spec / name).resolve(strict=True)
        except (OSError, RuntimeError):
            continue
        if local.is_relative_to(root) and local.suffix == ".png" and local.is_file():
            found[name] = local
    return found


def _wanted(publication: Mapping | None, settings, spec: Path) -> tuple[list[str], str]:
    if not publication or not (publication.get("decision") or {}).get("needed"):
        return [], "nothing"
    if settings.publish == "never":
        return [], "off"
    every = hosted_files(publication)
    if settings.publish == "review":
        approved = hosted_files(publication, approved_signatures(spec))
        if not approved:
            return [], "waiting-review" if every else "nothing"
        return approved, "published"
    return every, "published" if every else "nothing"


def _azure_urls(
    ref: PrRef, auth: tuple[str, str], session: Any, files: Mapping[str, Path]
) -> dict[str, str] | None:
    attachments = AzureAttachments(ref, auth, session)
    existing = attachments.names()
    if existing is None:
        return None
    urls: dict[str, str] = {}
    wanted: set[str] = set()
    for name, local in files.items():
        digest = hashlib.sha256(local.read_bytes()).hexdigest()[:12]
        side = "before" if "/base/" in f"/{name}" else "after"
        attachment = f"{ATTACHMENT_PREFIX}{digest}-{side}-{local.stem}.png"
        wanted.add(attachment)
        url = attachments.upload(attachment, local)
        if url is None and attachment in existing:
            url = attachments.url_of(attachment)
        if url:
            urls[name] = url
    for old in existing:
        if old not in wanted:
            attachments.delete(old)
    return urls


def sync_pr_captures(
    *,
    project_dir: Path | str,
    spec_dir: Path | str,
    spec_name: str,
    provider: str,
    pr_url: str | None,
    remote: str = "origin",
    lang: str = "fr",
    gh: str | None = None,
    glab: str | None = None,
    azure_auth: tuple[str, str] | None = None,
    bitbucket_headers: Mapping[str, str] | None = None,
    session: Any = None,
    git: Callable[..., Any] = run_git,
    run: Callable[[list[str], Path], tuple[int, str]] = run_cli,
) -> dict:
    """Host the task's publishable captures and write the PR's section; what it did."""
    project, spec = Path(project_dir), Path(spec_dir)
    result: dict = {
        "version": 1,
        "prUrl": pr_url or "",
        "provider": provider,
        "syncedAt": _now(),
        "status": "failed",
        "hosted": 0,
        "reason": "",
    }
    try:
        ref = parse_pr_url(provider, pr_url)
        if ref is None:
            return _record(spec, {**result, "status": "unsupported"})
        settings = load_settings(project)
        publication = load_publication(spec)
        names, status = _wanted(publication, settings, spec)
        files = _local_files(spec, names)
        previous = load_sync(spec) or {}
        if not files and not (
            previous.get("section") and previous.get("prUrl") == pr_url
        ):
            # Nothing to show and no section shown before: no call to the forge.
            return _record(spec, {**result, "status": status})
        body = body_for(
            ref,
            project,
            gh=gh,
            glab=glab,
            azure_auth=azure_auth,
            bitbucket_headers=bitbucket_headers,
            session=session,
            run=run,
        )
        if body is None:
            return _record(spec, {**result, "reason": "no-credentials"})
        current = body.read()
        if current is None:
            return _record(spec, {**result, "reason": "pr-unreadable"})

        urls: dict[str, str] = {}
        if not files and START not in current:
            return _record(spec, {**result, "status": status})
        if ref.provider in BRANCH_FORGES:
            store = BranchStore(
                project,
                remote,
                settings.branch,
                retention_days=settings.retention_days,
                git=git,
            )
            hosted = store.update(spec_key(spec_name, ref.number), files or None)
            if not hosted.ok:
                return _record(spec, {**result, "reason": hosted.reason})
            urls = {
                name: ref.image_url(settings.branch, path)
                for name, path in hosted.paths.items()
            }
            result["purged"] = hosted.purged
        elif azure_auth and session is not None:
            found = _azure_urls(ref, azure_auth, session, files)
            if found is None:
                return _record(spec, {**result, "reason": "attachments-refused"})
            urls = found

        budget = None
        if body.max_chars is not None:
            budget = body.max_chars - len(replace_section(current, "")) - 2
        section = render_section(
            publication if status == "published" else None,
            urls,
            lang=lang,
            max_chars=budget,
        )
        updated = replace_section(current, section)
        if updated != current and not body.write(updated):
            return _record(spec, {**result, "reason": "pr-write-failed"})
        return _record(
            spec,
            {**result, "status": status, "hosted": len(urls), "section": bool(section)},
        )
    except (OSError, ValueError) as exc:
        logger.debug("captures sync failed: %s", type(exc).__name__)
        return _record(spec, {**result, "reason": "error"})


def task_spec_dir(manager: Any, spec_name: str) -> Path:
    """The copy of the task's spec folder whose publication is the newest."""
    from core.stacked_pr import spec_dir_of

    candidates = [
        spec_dir_of(manager, spec_name),
        Path(manager.get_worktree_path(spec_name)) / ".workpilot" / "specs" / spec_name,
    ]

    def stamp(path: Path) -> float:
        try:
            return (path / CAPTURES_DIR / "publication.json").stat().st_mtime
        except OSError:
            return -1.0

    return max(candidates, key=stamp)


def sync_after_pr(
    manager: Any, spec_name: str, provider: str, pr_url: str | None, remote: str | None
) -> dict:
    """`sync_pr_captures` with the credentials the pull request was created with."""
    try:
        import requests
        from core.bitbucket_pr import auth_headers
        from core.gh_executable import get_gh_executable
        from core.glab_executable import get_glab_executable
        from core.worktree_common import _get_app_language

        azure = (
            manager._get_azure_devops_credentials()
            if provider == "azure_devops"
            else None
        )
        return sync_pr_captures(
            project_dir=manager.project_dir,
            spec_dir=task_spec_dir(manager, spec_name),
            spec_name=spec_name,
            provider=provider,
            pr_url=pr_url,
            remote=remote or "origin",
            lang="fr" if _get_app_language() == "fr" else "en",
            gh=get_gh_executable() if provider == "github" else None,
            glab=get_glab_executable() if provider == "gitlab" else None,
            azure_auth=azure,
            bitbucket_headers=auth_headers() if provider == "bitbucket" else None,
            session=requests,
        )
    except (ImportError, OSError, ValueError) as exc:
        logger.debug("captures sync skipped: %s", type(exc).__name__)
        return {"status": "failed", "reason": "error"}

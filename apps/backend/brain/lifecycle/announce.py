"""A memory conflict queued here, said on the team's channels (opt-in, #352).

The issue's team notification: when a sync queues a pair for a person, the
people who wrote the two notes should hear of it where the team already
talks — the channels a project configures for "PR ready" (Teams, Slack,
Discord, Google Chat, a webhook). Off unless the project asks
(``WORKPILOT_MEMORY_CONFLICT_NOTIFY``, a switch beside the channels).

**A port, not an import.** The channels and their SSRF guard
(`services.notifications.channels.post_json`) live in ``services``, which
sits in the agents' import cycle; ``brain`` stays out of it. So the sender is
installed from above (`services/notifications/memory_conflicts.py`, when the
notifications are imported: the API, a build, the brain runner), and a
process without one announces nothing — the next one that has one does, as
what it announces is "what is queued here and was not announced yet".

**Which project.** The vault is shared by every project of the machine and
the queue names a memory (``knowledge/projects/<slug>/memory``), not a
folder; the webhooks are a project's own ``.workpilot/.env``. Each project
memory that reads the vault writes where its project lives
(``.workpilot-brain/projects.json``, this machine's, ignored by git), and an
entry is only believed when that folder still exists and is the project the
memory names.

**What goes out.** The project's folder name, the kind of note and the
signal, and for each note its title, a preview and its authors' git names —
names only, never an e-mail. A note is a teammate's text (rule S2): cleaned by
`security.untrusted.clean_untrusted`, expurgated, cut short, with ``<``,
``>`` and ``@`` replaced so that it can mention nobody (``@here``,
``<!channel>``); a text the injection scanner flags is withheld, not sent.

**Never twice.** A pair is claimed in ``.workpilot-brain/announced.json``
(this machine's, ignored by git) before it is sent and released when no
channel took it. Once a channel has, a ``notify`` line goes to the vault's
journal: a teammate whose own sync queues the same pair sees it there after
the next pull, and does not announce it again.
"""

from __future__ import annotations

import json
import logging
import re
import subprocess
import threading
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from typing import Any, Protocol

from foundation.json_ledger import update_json

from ..memories import redact
from ..sync import _git, git_available
from ..tasks import project_name
from .arbitration import open_conflicts
from .journal import JournalEntry, append
from .journal import read as read_journal
from .store import FOLDER_KIND, memory_base

logger = logging.getLogger(__name__)

__all__ = [
    "ANNOUNCED_FILE",
    "PROJECTS_FILE",
    "Announcer",
    "authors",
    "install",
    "installed",
    "notice_of",
    "project_dir_of",
    "register_project",
    "start",
    "sweep",
]

ANNOUNCED_FILE = ".workpilot-brain/announced.json"
PROJECTS_FILE = ".workpilot-brain/projects.json"

_MAX_PROJECTS = 500
_MAX_IDS = 2000
_MAX_TITLE = 80
_MAX_TEXT = 200
_MAX_AUTHOR = 60
_MAX_AUTHORS = 3
_BRAIN_AUTHOR = "WorkPilot Brain"
"""The identity `sync` commits with when the vault has none: nobody wrote that."""
_SIGNALS = ("value", "recommendation", "negation", "textual", "reopened")
_SHA = re.compile(r"[0-9a-f]{4,40}")
_NEUTRAL = str.maketrans({"<": "‹", ">": "›", "@": "＠"})


class Announcer(Protocol):
    """What `services.notifications` installs: the project's channels."""

    def enabled(self, project_dir: Path) -> bool:
        """Whether the project asked for the notice and has a channel for it."""

    def send(self, project_dir: Path, project: str, notices: list[dict]) -> bool:
        """Post *notices* on the project's channels; whether one took them."""


_announcer: Announcer | None = None
_sweeping = threading.Lock()


def install(announcer: Announcer | None) -> None:
    """The sender every later sweep uses (``None`` takes it away)."""
    global _announcer
    _announcer = announcer


def installed() -> Announcer | None:
    return _announcer


def _read_json(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


# -- where each project lives (this machine's) --------------------------------


def _main_dir(project_dir: Path) -> Path:
    """The project a folder belongs to: a task's worktree is its project's."""
    resolved = project_dir.resolve()
    parts = resolved.parts
    for marker in (".workpilot", ".worktrees"):
        if marker in parts and parts.index(marker) > 1:
            return Path(*parts[: parts.index(marker)])
    return resolved


def register_project(root: Path, project_dir: Path | str) -> None:
    """Remember which folder the memory of *project_dir*'s project is for."""
    try:
        main = _main_dir(Path(project_dir))
        if not main.is_dir():
            return
        base = memory_base(project_name(main)).as_posix()
        path = root / PROJECTS_FILE
        if _read_json(path).get(base) == str(main):
            return

        def change(data: Any) -> dict[str, Any]:
            known = data if isinstance(data, dict) else {}
            known.pop(base, None)
            known[base] = str(main)
            while len(known) > _MAX_PROJECTS:
                known.pop(next(iter(known)))
            return known

        update_json(path, dict, change)
    except OSError as exc:
        logger.debug("brain: project folder not registered: %s", exc)


def project_dir_of(root: Path, base: str) -> Path | None:
    """The folder of the project whose memory is *base*, or ``None``.

    The file is this machine's, but a hand (or a vault that committed it)
    may have changed it: a folder that is gone, relative, or that is not the
    project the memory names is not believed.
    """
    raw = _read_json(root / PROJECTS_FILE).get(base)
    if not isinstance(raw, str) or not raw:
        return None
    path = Path(raw)
    if not path.is_absolute():
        return None
    try:
        resolved = path.resolve()
    except OSError:
        return None
    if not resolved.is_dir() or memory_base(project_name(resolved)).as_posix() != base:
        return None
    return resolved


# -- what is said ---------------------------------------------------------------


def _plain(text: str, limit: int) -> tuple[str, bool]:
    """A teammate's text, safe to post: ``(text, withheld)``."""
    from security.untrusted import clean_untrusted

    cleaned = clean_untrusted(text or "", kind="comment", source="memory note")
    if cleaned.suspicious:
        return "", True
    one = " ".join(redact(cleaned.text).split()).translate(_NEUTRAL)
    return (one if len(one) <= limit else one[: limit - 1].rstrip() + "…"), False


def _log_args(rel: str) -> list[str] | None:
    """``git log`` arguments naming who wrote *rel*; ``None`` when nothing does.

    A conflict copy (``x.conflict-<sha>.md``) was written by this machine's
    sync: its author is the one of the remote's version, at that commit.
    """
    name = PurePosixPath(rel).name
    if ".conflict-" not in name:
        return ["log", "-n", "20", "--format=%an", "--", rel]
    stem, _, rest = name.partition(".conflict-")
    sha = rest.rsplit(".", 1)[0]
    if not _SHA.fullmatch(sha):
        return None
    original = (PurePosixPath(rel).parent / f"{stem}.md").as_posix()
    return ["log", "-n", "1", "--format=%an", sha, "--", original]


def authors(root: Path, rel: str) -> list[str]:
    """The git names of who wrote the note at *rel*, newest first; at most 3.

    A name that holds an ``@`` (someone's e-mail set as their name) is left
    out: the notice names people, it never hands out an address.
    """
    args = _log_args(rel) if rel else None
    if args is None or not git_available():
        return []
    try:
        found = _git(root, *args)
    except (OSError, subprocess.SubprocessError):
        return []
    if found.returncode != 0:
        return []
    names: list[str] = []
    for line in found.stdout.splitlines():
        name = line.strip()
        if not name or "@" in name or name == _BRAIN_AUTHOR:
            continue
        clean, withheld = _plain(name, _MAX_AUTHOR)
        if clean and not withheld and clean not in names:
            names.append(clean)
        if len(names) == _MAX_AUTHORS:
            break
    return names


def _side(root: Path, item: dict[str, Any], side: str) -> dict[str, Any]:
    data = item.get(side)
    data = data if isinstance(data, dict) else {}
    title, title_held = _plain(str(data.get("title") or ""), _MAX_TITLE)
    text, text_held = _plain(
        str(data.get("text") or data.get("preview") or ""), _MAX_TEXT
    )
    return {
        "title": title,
        "text": text,
        "withheld": title_held or text_held,
        "authors": authors(root, str(data.get("path") or "")),
    }


def notice_of(root: Path, item: dict[str, Any]) -> dict[str, Any]:
    """One queued pair as the channels hear of it: codes from closed lists."""
    kind = item.get("kind")
    signal = item.get("signal")
    return {
        "id": str(item.get("id") or ""),
        "kind": kind if kind in FOLDER_KIND.values() else "note",
        "signal": signal if signal in _SIGNALS else "textual",
        "escalated": isinstance(item.get("escalated"), dict),
        "a": _side(root, item, "a"),
        "b": _side(root, item, "b"),
    }


# -- never twice ------------------------------------------------------------------


def _paths(item: dict[str, Any]) -> frozenset[str]:
    return frozenset(
        str(side.get("path") or "")
        for side in (item.get("a"), item.get("b"))
        if isinstance(side, dict)
    )


def _journalled(root: Path, base: str) -> set[frozenset[str]]:
    """The pairs a ``notify`` line of the vault's journal says were announced."""
    return {
        frozenset((entry.note, *entry.related))
        for entry in read_journal(root, base, limit=5000)
        if entry.action == "notify"
    }


def _claim(root: Path, ids: list[str]) -> set[str]:
    """Mark *ids* as being announced; the ones no one had marked before."""
    claimed: set[str] = set()
    stamp = datetime.now(UTC).isoformat(timespec="seconds")

    def change(data: Any) -> dict[str, Any]:
        data = data if isinstance(data, dict) else {}
        known = data.get("ids")
        known = known if isinstance(known, dict) else {}
        for pair in ids:
            if pair and pair not in known:
                known[pair] = stamp
                claimed.add(pair)
        newest = sorted(known.items(), key=lambda kv: str(kv[1]))[-_MAX_IDS:]
        return {**data, "ids": dict(newest)}

    try:
        update_json(root / ANNOUNCED_FILE, dict, change)
    except OSError as exc:
        # Not recorded, not sent: a notice that could not be marked would be
        # sent again at every pull.
        logger.warning("brain: conflict notices not recorded: %s", exc)
        return set()
    return claimed


def _release(root: Path, ids: set[str]) -> None:
    def change(data: Any) -> dict[str, Any]:
        data = data if isinstance(data, dict) else {}
        known = data.get("ids")
        known = known if isinstance(known, dict) else {}
        return {**data, "ids": {k: v for k, v in known.items() if k not in ids}}

    try:
        update_json(root / ANNOUNCED_FILE, dict, change)
    except OSError as exc:
        logger.warning("brain: conflict notices not released: %s", exc)


def _sweep_base(
    root: Path, announcer: Announcer, base: str, items: list[dict[str, Any]]
) -> int:
    project_dir = project_dir_of(root, base)
    if project_dir is None or not announcer.enabled(project_dir):
        return 0
    journalled = _journalled(root, base)
    fresh = [item for item in items if _paths(item) not in journalled]
    claimed = _claim(root, [str(item.get("id") or "") for item in fresh])
    todo = [item for item in fresh if str(item.get("id") or "") in claimed]
    if not todo:
        return 0
    notices = [notice_of(root, item) for item in todo]
    try:
        delivered = announcer.send(project_dir, project_dir.name, notices)
    except (OSError, ValueError, RuntimeError) as exc:
        logger.warning("brain: conflict notice not sent: %s", exc)
        delivered = False
    if not delivered:
        _release(root, claimed)
        return 0
    for item in todo:
        a, b = item.get("a"), item.get("b")
        a = a if isinstance(a, dict) else {}
        b = b if isinstance(b, dict) else {}
        append(
            root,
            base,
            JournalEntry(
                action="notify",
                actor="sync",
                note=str(a.get("path") or ""),
                title=str(a.get("title") or ""),
                reason_code="conflict-announced",
                related=[str(b.get("path") or "")],
            ),
        )
    return len(todo)


def sweep(root: Path) -> int:
    """Announce what is queued here and was never announced; how many pairs.

    Nothing without an installed sender; one sweep at a time in a process.
    """
    announcer = _announcer
    if announcer is None or not _sweeping.acquire(blocking=False):
        return 0
    try:
        by_base: dict[str, list[dict[str, Any]]] = {}
        for item in open_conflicts(root):
            by_base.setdefault(str(item.get("base") or ""), []).append(item)
        return sum(
            _sweep_base(root, announcer, base, items) for base, items in by_base.items()
        )
    finally:
        _sweeping.release()


def _run(root: Path) -> None:
    try:
        sweep(root)
    except OSError as exc:
        logger.warning("brain: conflict notices not swept: %s", exc)


def start(root: Path) -> threading.Thread | None:
    """Sweep in a thread of its own, so that a slow webhook never holds up a
    read or a sync. Not a daemon: the process waits for it (each channel is
    bounded by its timeout) rather than dropping a notice half sent."""
    if _announcer is None:
        return None
    thread = threading.Thread(target=_run, args=(root,), name="memory-conflict-notice")
    thread.start()
    return thread

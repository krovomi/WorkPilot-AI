"""The archify JSON IR: reading it, pinning it to real code, and diffing ids.

Three jobs, and the third is the one the whole Kanban feature rests on.

**Pinning.** `meta.repository` + `components[].sources[]` turn a diagram from a
drawing into evidence: the viewer shows SRC markers and revision-pinned links,
and archify verifies them by reading the blobs at that commit. It reads *blobs*,
not the working tree — so a file the build has not committed has nothing to
verify against and the whole render is refused. That is why pinning here is
conditional and silent: a path that does not exist at the revision is dropped, a
component left with no sources keeps its meaning, and a revision that will not
resolve means `meta.repository` is omitted entirely. A diagram without evidence
is still a true diagram; a diagram that fails to render is nothing.

**Id continuity.** `archify compare` matches components by `id`. An "after" model
authored from scratch shares no ids with the "before" one, so every component
reads as removed and re-added and the delta is noise wearing the costume of a
finding. The authoring step is given the base model and told to keep ids; this
module is what checks that it did, mechanically, afterwards. Under the
threshold the delta is reported unreliable rather than displayed — the same
reflex as coverage reporting *not applicable* rather than 0%.
"""

from __future__ import annotations

import json
import logging
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

#: Below this share of surviving base ids, a delta says more about the author's
#: naming than about the code, so it is not shown as a delta.
ID_CONTINUITY_THRESHOLD = 0.6

#: A `meta.repository.revision` must be a full 40-character sha; archify rejects
#: an abbreviated one rather than guessing.
_SHA_LENGTH = 40


class IRError(ValueError):
    """The file on disk is not an architecture IR we can work with."""


def load(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise IRError(f"no architecture model at {path.name}") from exc
    except json.JSONDecodeError as exc:
        raise IRError(f"{path.name} is not valid JSON: {exc.msg}") from exc
    except UnicodeDecodeError as exc:
        raise IRError(f"{path.name} is not UTF-8 text") from exc
    except OSError as exc:  # a directory, or no permission to read it
        raise IRError(f"{path.name} cannot be read: {exc.strerror or exc}") from exc
    if not isinstance(data, dict):
        raise IRError(f"{path.name} does not hold a JSON object")
    if data.get("diagram_type") != "architecture":
        raise IRError(
            f"{path.name} is a {data.get('diagram_type')!r} diagram, not architecture"
        )
    return data


def save(path: Path, ir: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(ir, indent="\t") + "\n", encoding="utf-8")


def normalise_path(path: str) -> str:
    """A cited or changed path as git lists it: posix, no leading `./` or `/`.

    Only those prefixes go. `str.lstrip("./")` would also eat the dot of
    `.github/` — a source no `git ls-tree` line would ever match again.
    """
    path = path.replace("\\", "/")
    while path.startswith(("./", "/")):
        path = path[2:] if path.startswith("./") else path[1:]
    return path


def components(ir: dict[str, Any]) -> list[dict[str, Any]]:
    """The model's components that are objects; nothing when the list is not one.

    The model is written by a session, so its shape is a claim until archify
    has validated it — and the code that reads it runs before validation.
    """
    raw = ir.get("components")
    return [c for c in raw if isinstance(c, dict)] if isinstance(raw, list) else []


def sources(component: dict[str, Any]) -> list[dict[str, Any]]:
    """A component's cited sources that are objects."""
    raw = component.get("sources")
    return [s for s in raw if isinstance(s, dict)] if isinstance(raw, list) else []


def component_ids(ir: dict[str, Any]) -> set[str]:
    return {str(c["id"]) for c in components(ir) if c.get("id")}


def source_paths(ir: dict[str, Any]) -> set[str]:
    """Every repository-relative path any component cites, normalised to posix."""
    return {
        normalise_path(str(source["path"]))
        for component in components(ir)
        for source in sources(component)
        if source.get("path")
    }


# --------------------------------------------------------------------------- #
# Pinning to real code
# --------------------------------------------------------------------------- #


def _git(args: list[str], cwd: Path) -> str | None:
    try:
        out = subprocess.run(
            ["git", *args], cwd=str(cwd), capture_output=True, text=True, timeout=30
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return out.stdout.strip() if out.returncode == 0 else None


def _origin_url(project_dir: Path) -> str | None:
    url = _git(["remote", "get-url", "origin"], project_dir)
    if not url:
        return None
    # Credentials in a clone URL are identity noise archify redacts anyway, and
    # this value is written to a file a person reads.
    if "@" in url and url.startswith(("http://", "https://")):
        scheme, _, rest = url.partition("://")
        url = f"{scheme}://{rest.rpartition('@')[2]}"
    return url


def _head_revision(project_dir: Path) -> str | None:
    sha = _git(["rev-parse", "HEAD"], project_dir)
    return sha if sha and len(sha) == _SHA_LENGTH else None


def _tracked_at(project_dir: Path, revision: str, paths: set[str]) -> set[str]:
    """Which of `paths` have a blob at `revision`. Empty on any git failure."""
    if not paths:
        return set()
    listed = _git(["ls-tree", "-r", "--name-only", revision], project_dir)
    if listed is None:
        return set()
    tracked = set(listed.splitlines())
    return {p for p in paths if p in tracked}


def _link_mode(url: str) -> str | None:
    """`web` for the two forges archify can build links for, else local-only."""
    host = urlparse(url).hostname

    # Support SCP-like Git remotes (for example: git@github.com:org/repo.git)
    if host is None and "@" in url and ":" in url:
        after_at = url.rsplit("@", 1)[1]
        host = after_at.split(":", 1)[0]

    lowered_host = host.lower() if host else ""
    if lowered_host in {"github.com", "gitee.com"} or lowered_host.endswith(
        (".github.com", ".gitee.com")
    ):
        return None  # `web` is the default; saying so adds nothing
    return "local-only"


def pin_repository(
    ir: dict[str, Any], project_dir: Path, revision: str | None = None
) -> tuple[dict[str, Any], str | None]:
    """Attach verifiable provenance where it holds, and drop it where it does not.

    Returns the IR and the revision actually pinned (None when nothing was).
    """
    url = _origin_url(project_dir)
    sha = revision or _head_revision(project_dir)
    if not url or not sha:
        _strip_evidence(ir)
        return ir, None

    declared = source_paths(ir)
    tracked = _tracked_at(project_dir, sha, declared)
    if not tracked:
        # Nothing the model cites exists at this commit — mid-build, that means
        # the work is uncommitted. Evidence would refuse the render; drop it.
        _strip_evidence(ir)
        return ir, None

    for component in components(ir):
        kept = [
            s
            for s in sources(component)
            if normalise_path(str(s.get("path", ""))) in tracked
        ]
        if kept:
            component["sources"] = kept
        else:
            component.pop("sources", None)

    meta = ir.get("meta")
    if not isinstance(meta, dict):
        meta = ir["meta"] = {}
    repository: dict[str, Any] = {"url": url, "revision": sha}
    mode = _link_mode(url)
    if mode:
        repository["link_mode"] = mode
    meta["repository"] = repository
    return ir, sha


def _strip_evidence(ir: dict[str, Any]) -> None:
    """Remove provenance wholesale. Half-pinned evidence is a refused render."""
    meta = ir.get("meta")
    if isinstance(meta, dict):
        meta.pop("repository", None)
    for component in components(ir):
        component.pop("sources", None)


# --------------------------------------------------------------------------- #
# Id continuity
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class Continuity:
    """How much of the base model the head model still recognises."""

    reliable: bool
    ratio: float
    kept: int
    total: int
    lost: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, object]:
        return {
            "reliable": self.reliable,
            "ratio": round(self.ratio, 3),
            "kept": self.kept,
            "total": self.total,
            "lost": sorted(self.lost)[:20],
        }


def check_id_continuity(
    base: dict[str, Any],
    head: dict[str, Any],
    threshold: float = ID_CONTINUITY_THRESHOLD,
) -> Continuity:
    """Whether a delta between these two models would mean anything.

    An empty base is reliable by definition: there are no ids to lose, and the
    first model of a project is legitimately all-new.
    """
    base_ids = component_ids(base)
    if not base_ids:
        return Continuity(reliable=True, ratio=1.0, kept=0, total=0)

    head_ids = component_ids(head)
    kept = base_ids & head_ids
    ratio = len(kept) / len(base_ids)
    return Continuity(
        reliable=ratio >= threshold,
        ratio=ratio,
        kept=len(kept),
        total=len(base_ids),
        lost=list(base_ids - head_ids),
    )

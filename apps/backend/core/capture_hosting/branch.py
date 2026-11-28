"""The images of the pull requests, kept on one branch of the repository.

GitHub has no API to attach an image to a pull request body, and GitLab's and
Bitbucket's would need one more credential per forge. The repository the task
just pushed to already accepts our pushes, so the published copies go to a
branch of their own (`CAPTURES_BRANCH`, ``workpilot-captures`` by default):

- it shares no history with the code, so it can never be merged by mistake,
  and the task branch (the one the PR merges) carries no image;
- each publish writes a single commit with no parent, built from the previous
  tree without the tasks older than the retention: the branch has one commit,
  and a purged image is no longer reachable from it;
- it is built with git plumbing in a temporary index (`hash-object`,
  `update-index`, `write-tree`, `commit-tree`): the person's checkout, index
  and worktrees are never touched;
- the push is guarded by `--force-with-lease` on the commit it replaces, and
  retried on a race with another task's publish.

Each image path ends with a hash of its bytes, so a capture taken again gets a
new URL and no forge or browser shows a cached older image.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import tempfile
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

from foundation.git_executable import get_isolated_git_env, run_git

__all__ = ["BranchStore", "PublishResult", "spec_key"]

logger = logging.getLogger(__name__)

INDEX = "index.json"
README = "README.md"
PRIVATE_REF = "refs/workpilot/captures"
ATTEMPTS = 3
_KEY = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$")
_IDENTITY = {
    "GIT_AUTHOR_NAME": "WorkPilot captures",
    "GIT_AUTHOR_EMAIL": "captures@workpilot.invalid",
    "GIT_COMMITTER_NAME": "WorkPilot captures",
    "GIT_COMMITTER_EMAIL": "captures@workpilot.invalid",
}
_README_TEXT = """# Captures des pull requests / Pull request screenshots

Branche écrite par WorkPilot : les captures publiées dans les pull requests,
données personnelles remplacées par des fausses. Elle ne partage aucun
historique avec le code ; ne pas la fusionner. Chaque tâche y reste le nombre
de jours fixé par `CAPTURES_RETENTION_DAYS`.

Branch written by WorkPilot: the screenshots shown in pull requests, personal
data replaced by fakes. It shares no history with the code; never merge it.
Each task stays for `CAPTURES_RETENTION_DAYS` days.
"""


def spec_key(spec_name: str, number: int) -> str:
    """The folder of one task's pull request on the branch."""
    name = spec_name if _KEY.match(spec_name or "") else ""
    if not name:
        name = hashlib.sha256((spec_name or "").encode("utf-8")).hexdigest()[:16]
    return f"{name}-pr{int(number)}"


@dataclass
class PublishResult:
    ok: bool
    #: Published file (as `publication.json` names it) → path on the branch.
    paths: dict[str, str]
    reason: str = ""
    purged: int = 0


class BranchStore:
    """One repository's captures branch on one remote."""

    def __init__(
        self,
        repo_dir: Path | str,
        remote: str,
        branch: str,
        *,
        retention_days: int = 30,
        git: Callable[..., object] = run_git,
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self.repo_dir = Path(repo_dir)
        self.remote = remote
        self.branch = branch
        self.retention_days = retention_days
        self._git = git
        self._now = now

    # -- git ---------------------------------------------------------------

    def _run(
        self,
        args: list[str],
        *,
        env: Mapping[str, str] | None = None,
        stdin=None,
        timeout=60,
    ):
        return self._git(
            args,
            cwd=self.repo_dir,
            timeout=timeout,
            input_data=stdin,
            env=dict(env) if env is not None else None,
        )

    def _remote_head(self) -> tuple[bool, str]:
        """(reachable, sha of the branch on the remote or "")."""
        result = self._run(
            ["ls-remote", "--heads", self.remote, f"refs/heads/{self.branch}"],
            timeout=60,
        )
        if result.returncode != 0:
            return False, ""
        for line in (result.stdout or "").splitlines():
            sha, _, ref = line.partition("\t")
            if ref.strip() == f"refs/heads/{self.branch}" and re.fullmatch(
                r"[0-9a-f]{40,64}", sha
            ):
                return True, sha
        return True, ""

    def _tree(self, head: str) -> tuple[dict[str, str], dict]:
        """The files of `head` (path → blob) and its index, after fetching it."""
        if not head:
            return {}, {}
        fetched = self._run(
            [
                "fetch",
                "--no-tags",
                "--quiet",
                self.remote,
                f"+refs/heads/{self.branch}:{PRIVATE_REF}",
            ],
            timeout=120,
        )
        if fetched.returncode != 0:
            raise OSError("fetch-failed")
        listed = self._run(["ls-tree", "-r", "-z", head])
        if listed.returncode != 0:
            raise OSError("read-failed")
        files: dict[str, str] = {}
        for entry in (listed.stdout or "").split("\0"):
            meta, _, path = entry.partition("\t")
            fields = meta.split()
            if len(fields) == 3 and fields[1] == "blob" and path:
                files[path] = fields[2]
        index: dict = {}
        if INDEX in files:
            shown = self._run(["cat-file", "blob", files[INDEX]])
            try:
                index = json.loads(shown.stdout or "{}")
            except ValueError:
                index = {}
        return files, index if isinstance(index, dict) else {}

    def _blob(self, *, path: Path | None = None, text: str | None = None) -> str:
        if path is not None:
            result = self._run(["hash-object", "-w", "--", str(path)])
        else:
            result = self._run(["hash-object", "-w", "--stdin"], stdin=text or "")
        sha = (result.stdout or "").strip()
        if result.returncode != 0 or not re.fullmatch(r"[0-9a-f]{40,64}", sha):
            raise OSError("write-failed")
        return sha

    def _commit(self, files: Mapping[str, str], message: str) -> str:
        with tempfile.TemporaryDirectory(prefix="wp-captures-") as tmp:
            env = get_isolated_git_env()
            env["GIT_INDEX_FILE"] = str(Path(tmp) / "index")
            env.update(_IDENTITY)
            if self._run(["read-tree", "--empty"], env=env).returncode != 0:
                raise OSError("write-failed")
            info = "".join(
                f"100644 {sha}\t{path}\n" for path, sha in sorted(files.items())
            )
            if (
                self._run(
                    ["update-index", "--index-info"], env=env, stdin=info
                ).returncode
                != 0
            ):
                raise OSError("write-failed")
            tree = self._run(["write-tree"], env=env)
            tree_sha = (tree.stdout or "").strip()
            if tree.returncode != 0 or not tree_sha:
                raise OSError("write-failed")
            commit = self._run(["commit-tree", tree_sha, "-m", message], env=env)
            sha = (commit.stdout or "").strip()
            if commit.returncode != 0 or not re.fullmatch(r"[0-9a-f]{40,64}", sha):
                raise OSError("write-failed")
            return sha

    def _push(self, commit: str, lease: str) -> str:
        """ "" when pushed, "stale" on a race, else the refusal."""
        result = self._run(
            [
                "push",
                "--porcelain",
                f"--force-with-lease=refs/heads/{self.branch}:{lease}",
                self.remote,
                f"{commit}:refs/heads/{self.branch}",
            ],
            timeout=180,
        )
        if result.returncode == 0:
            return ""
        text = f"{result.stdout or ''}\n{result.stderr or ''}".lower()
        if "stale info" in text or "fetch first" in text or "non-fast-forward" in text:
            return "stale"
        return "push-refused"

    # -- publish -----------------------------------------------------------

    def _expired(self, index: Mapping) -> set[str]:
        if self.retention_days <= 0:
            return set()
        limit = self._now() - timedelta(days=self.retention_days)
        expired: set[str] = set()
        for key, entry in (index.get("tasks") or {}).items():
            try:
                updated = datetime.fromisoformat(str((entry or {}).get("updatedAt")))
            except ValueError:
                expired.add(key)
                continue
            if updated.tzinfo is None:
                updated = updated.replace(tzinfo=UTC)
            if updated < limit:
                expired.add(key)
        return expired

    def update(self, key: str, files: Mapping[str, Path] | None) -> PublishResult:
        """Put `files` (published name → local copy) under `key`, or remove `key` (None).

        Never raises: a refusal is the result's `reason`.
        """
        names: dict[str, str] = {}
        for name, local in (files or {}).items():
            digest = hashlib.sha256(local.read_bytes()).hexdigest()[:12]
            side = "before" if "/base/" in f"/{name}" else "after"
            names[name] = f"{key}/{side}/{local.stem}-{digest}.png"
        for _attempt in range(ATTEMPTS):
            try:
                reachable, head = self._remote_head()
                if not reachable:
                    return PublishResult(False, {}, "remote-unreachable")
                tree, index = self._tree(head)
                tasks = dict(index.get("tasks") or {})
                expired = self._expired(index) - {key}
                if not files and key not in tasks and not expired:
                    return PublishResult(True, {})
                drop = expired | {key}
                kept = {
                    path: sha
                    for path, sha in tree.items()
                    if path not in (INDEX, README) and path.split("/", 1)[0] not in drop
                }
                for gone in drop:
                    tasks.pop(gone, None)
                if files:
                    for name, path in names.items():
                        kept[path] = self._blob(path=files[name])
                    tasks[key] = {
                        "updatedAt": self._now().isoformat(timespec="seconds"),
                        "files": sorted(names.values()),
                    }
                if not tasks:
                    kept = {}
                kept[INDEX] = self._blob(
                    text=json.dumps(
                        {"version": 1, "tasks": tasks}, indent=2, sort_keys=True
                    )
                )
                kept[README] = self._blob(text=_README_TEXT)
                commit = self._commit(kept, f"captures: {key}")
                refused = self._push(commit, head)
            except OSError as exc:
                return PublishResult(False, {}, str(exc) or "write-failed")
            if not refused:
                return PublishResult(True, names, purged=len(expired))
            if refused != "stale":
                return PublishResult(False, {}, refused)
            logger.debug("captures branch moved during the publish, again")
        return PublishResult(False, {}, "busy")

"""What a server run may touch on the server's disk.

Every run of every organization executes as the same OS user, beside the
clones of every other project (``REPOS_ROOT``), the server's own state and
the other runs. Unconfined, an agent working on one project could read
another tenant's code, its build memory or its session transcripts. So each
run starts through ``runners/confined_run.py``, which restricts it with
Landlock (`foundation.landlock`) before the agent starts:

- **read and write**: the run's own clone, its project's home directory
  (``REPOS_ROOT/.run-homes/<project>``: the build memory, the CLI sessions and
  the package caches of that project only), the run's private temporary
  directory, and the few devices every program writes to;
- **read only**: the rest of the filesystem, so the interpreter, the tools
  and WorkPilot's own code still run;
- **neither**: every other clone and project home, the server user's home
  (its credentials and state are the deployment's), the shared temporary
  directories, the server's database file, logs and ``.env`` files.

Git still reaches the forge as the server does: the global git config and
the SSH directory of the server user are readable, never writable.

``WORKPILOT_RUN_ISOLATION`` is ``required`` by default: a machine that cannot
enforce Landlock fails each run with the reason instead of running it open.
``off`` starts runs unconfined, for a deployment where every user may read
every project, and the server logs it.
"""

from __future__ import annotations

import json
import os
import sys
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

ISOLATION_ENV = "WORKPILOT_RUN_ISOLATION"
OFF = "off"
REQUIRED = "required"

#: Under REPOS_ROOT, never a project id (those are UUIDs).
RUN_HOMES_DIR = ".run-homes"

_BACKEND_DIR = Path(__file__).resolve().parents[2]
_REPO_ROOT = _BACKEND_DIR.parents[1]
_CONFINE = _BACKEND_DIR / "runners" / "confined_run.py"

#: Devices a program opens for writing (all optional).
_WRITABLE_DEVICES = (
    "/dev/null",
    "/dev/zero",
    "/dev/full",
    "/dev/tty",
    "/dev/ptmx",
    "/dev/pts",
)

#: Shared temporary directories: one run's files there are another's to read.
_SHARED_TMP = ("/tmp", "/var/tmp", "/dev/shm")

#: In the server user's home, what a run may read: git's identity and the
#: transport git uses to reach the forge, and where CLIs are installed.
_HOME_READABLE = (
    ".gitconfig",
    ".config/git/config",
    ".ssh",
    ".local/bin",
    ".local/lib",
    ".nvm",
    ".npm-global",
    ".bun/bin",
    ".volta",
    ".cargo/bin",
    ".deno/bin",
    ".pyenv",
    "go/bin",
)

#: Server state beside the backend's code, by name or suffix.
_SERVER_STATE_NAMES = (".env",)
_SERVER_STATE_SUFFIXES = (".log", ".sqlite3", ".sqlite3-wal", ".sqlite3-shm", ".db")


def isolation_mode(environ: dict[str, str] | None = None) -> str:
    value = (environ if environ is not None else os.environ).get(ISOLATION_ENV, "")
    return OFF if value.strip().lower() == OFF else REQUIRED


def project_home(repos_root: Path, project_id: str) -> Path:
    return repos_root / RUN_HOMES_DIR / project_id


@dataclass(frozen=True)
class RunPolicy:
    read_only: tuple[str, ...]
    read_write: tuple[str, ...]
    list_only: tuple[str, ...] = ()

    def to_json(self) -> str:
        return json.dumps(
            {
                "read_only": list(self.read_only),
                "read_write": list(self.read_write),
                "list_only": list(self.list_only),
            },
            indent=1,
        )


def _real(path: Path | str) -> Path:
    return Path(os.path.realpath(path))


def _within(path: Path, root: Path) -> bool:
    return path == root or root in path.parents


def readable_complement(
    denied: Iterable[Path], top: Path = Path("/")
) -> tuple[list[Path], list[Path]]:
    """What covers everything under ``top`` but ``denied``: paths to grant
    for reading, and directories whose entries may only be listed.

    Landlock only grants, and a grant holds for a whole subtree: to keep a
    subtree out, its parent's other children are granted one by one, down to
    it. The parents walked through may be listed only when no denied
    directory lies beneath them (a listing would name another project's
    files); a denied file beside them stays unreadable either way. A symbolic
    link is granted as its target, and skipped when the target is, or
    contains, a denied path.
    """
    denied = {_real(p) for p in denied}
    denied_dirs = {d for d in denied if d.is_dir()}
    granted: list[Path] = []
    listable: list[Path] = []

    def touches_denied(path: Path) -> bool:
        return any(_within(path, d) or _within(d, path) for d in denied)

    def walk(directory: Path) -> None:
        if not any(_within(d, directory) for d in denied_dirs):
            listable.append(directory)
        try:
            names = sorted(os.listdir(directory))
        except OSError:
            return
        for name in names:
            child = directory / name
            if child.is_symlink():
                if not touches_denied(_real(child)):
                    granted.append(child)
                continue
            if child in denied:
                continue
            if any(_within(d, child) for d in denied):
                if child.is_dir():
                    walk(child)
                continue
            granted.append(child)

    top = _real(top)
    if top in denied:
        return [], []
    if not touches_denied(top):
        return [top], []
    walk(top)
    return granted, listable


def _server_state(backend_dir: Path, repo_root: Path, database_url: str) -> list[Path]:
    found: list[Path] = [repo_root / ".env-files"]
    try:
        entries = list(backend_dir.iterdir())
    except OSError:
        entries = []
    for entry in entries:
        if entry.name in _SERVER_STATE_NAMES or entry.name.endswith(
            _SERVER_STATE_SUFFIXES
        ):
            found.append(entry)
    if database_url.startswith("sqlite") and ":///" in database_url:
        db = Path(database_url.split(":///", 1)[1])
        found += [
            db.with_name(db.name + suffix)
            for suffix in ("", "-wal", "-shm", "-journal")
        ]
    return found


def build_policy(
    *,
    clone: Path,
    home: Path,
    scratch: Path,
    repos_root: Path,
    server_home: Path,
    database_url: str,
    backend_dir: Path = _BACKEND_DIR,
    repo_root: Path = _REPO_ROOT,
    interpreter_dirs: Iterable[Path] = (Path(sys.prefix), Path(sys.base_prefix)),
    fs_root: Path = Path("/"),
) -> RunPolicy:
    """The policy of one run of the project cloned at ``clone``.

    Two kinds of denial: the other projects and the server's state are never
    readable; the server user's home and the shared temporary directories
    are not either, except for what a run needs from them (WorkPilot's code
    and interpreter when installed there, git's configuration, CLIs).
    """
    writable = [_real(p) for p in (clone, home, scratch)]
    writable += [Path(d) for d in _WRITABLE_DEVICES if os.path.exists(d)]
    hard = [repos_root, *_server_state(backend_dir, repo_root, database_url)]
    regions = [server_home, *(Path(p) for p in _SHARED_TMP)]

    read_only, listable = readable_complement([*hard, *regions], fs_root)
    carve_outs = [
        repo_root,
        *interpreter_dirs,
        *(server_home / rel for rel in _HOME_READABLE),
    ]
    hard_real = [_real(p) for p in hard]
    for path in carve_outs:
        real = _real(path)
        if not real.exists() or any(_within(real, d) for d in hard_real):
            continue
        if not any(_within(real, _real(r)) for r in regions):
            continue  # already readable
        more, more_listable = readable_complement(hard, real)
        read_only += more
        listable += more_listable
    # The run's own directories sit under denied ones (its clone under
    # REPOS_ROOT, its scratch under /tmp): they are granted on their own.
    read_only = [
        p
        for p in dict.fromkeys(read_only)
        if not any(_within(_real(p), w) for w in writable)
    ]
    return RunPolicy(
        read_only=tuple(str(p) for p in read_only),
        read_write=tuple(str(p) for p in writable),
        list_only=tuple(str(p) for p in dict.fromkeys(listable)),
    )


def prepare_run(
    *,
    project_id: str,
    clone: Path,
    scratch: Path,
    repos_root: Path,
    database_url: str,
    env: dict[str, str],
    server_home: Path | None = None,
) -> list[str]:
    """Set ``env`` for a confined run and return the argv prefix that starts it.

    The run's ``HOME`` is its project's home and its temporary directory is
    its own; git keeps the server's identity. Call with the run's command
    appended to the returned prefix. ``server_home`` is the server user's
    home, the current user's by default.
    """
    server_home = server_home if server_home is not None else Path.home()
    home = project_home(repos_root, project_id)
    home.mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp = scratch / "tmp"
    tmp.mkdir(exist_ok=True, mode=0o700)

    env["HOME"] = str(home)
    for name in ("TMPDIR", "TEMP", "TMP"):
        env[name] = str(tmp)
    env.pop("XDG_CONFIG_HOME", None)
    env.pop("XDG_CACHE_HOME", None)
    env.pop("XDG_DATA_HOME", None)
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    gitconfig = server_home / ".gitconfig"
    if gitconfig.exists():
        env["GIT_CONFIG_GLOBAL"] = str(gitconfig)

    policy = build_policy(
        clone=clone,
        home=home,
        scratch=scratch,
        repos_root=repos_root,
        server_home=server_home,
        database_url=database_url,
    )
    policy_file = scratch / "isolation.json"
    policy_file.write_text(policy.to_json(), encoding="utf-8")
    return [sys.executable, "-I", str(_CONFINE), "--policy", str(policy_file), "--"]

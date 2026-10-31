"""Server mode: a run reaches its own project on disk, and nothing of another.

Every run executes as the server's OS user, beside every other project's
clone. Each one now starts confined by Landlock to its clone, its project's
home and its own temporary directory, with the rest of the filesystem read
only, and the other projects, the server user's home and the server's state
out of reach. The policy is checked here on any platform; on Linux, a real
confined process proves the refusals.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[2]
_BACKEND = _REPO / "apps" / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from foundation.platform import is_linux  # noqa: E402
from server.services.run_isolation import (  # noqa: E402
    ISOLATION_ENV,
    OFF,
    REQUIRED,
    build_policy,
    isolation_mode,
    prepare_run,
    project_home,
    readable_complement,
)

_CONFINE = _BACKEND / "runners" / "confined_run.py"


def _tree(root: Path) -> dict[str, Path]:
    repos = root / "repos"
    paths = {
        "repos": repos,
        "mine": repos / "proj-a",
        "theirs": repos / "proj-b",
        "server_home": root / "server-home",
        "code": root / "app",
        "scratch": root / "scratch",
    }
    for key in ("mine", "theirs", "server_home", "code", "scratch"):
        paths[key].mkdir(parents=True)
    (paths["theirs"] / "secret.py").write_text("THEIRS = 1\n", encoding="utf-8")
    (paths["mine"] / "mine.py").write_text("MINE = 1\n", encoding="utf-8")
    (paths["server_home"] / ".ssh").mkdir()
    (paths["server_home"] / ".claude").mkdir()
    (paths["server_home"] / ".claude" / "transcript.jsonl").write_text(
        "{}", encoding="utf-8"
    )
    (paths["server_home"] / ".gitconfig").write_text("[user]\n", encoding="utf-8")
    (paths["code"] / "server.log").write_text("log", encoding="utf-8")
    (paths["code"] / "db.sqlite3").write_text("db", encoding="utf-8")
    (paths["code"] / "run.py").write_text("", encoding="utf-8")
    return paths


def _covered(path: Path, granted: list[str]) -> bool:
    real = Path(os.path.realpath(path))
    return any(real == Path(g) or Path(g) in real.parents for g in granted)


def _policy(paths: dict[str, Path]):
    home = project_home(paths["repos"], "proj-a")
    home.mkdir(parents=True)
    return build_policy(
        clone=paths["mine"],
        home=home,
        scratch=paths["scratch"],
        repos_root=paths["repos"],
        server_home=paths["server_home"],
        database_url="sqlite+aiosqlite:///" + str(paths["code"] / "db.sqlite3"),
        backend_dir=paths["code"],
        repo_root=paths["code"],
        interpreter_dirs=(),
    )


def test_a_run_writes_its_own_project_and_nothing_of_another(tmp_path):
    paths = _tree(tmp_path)
    policy = _policy(paths)
    granted = [*policy.read_only, *policy.read_write]

    assert _covered(paths["mine"] / "mine.py", list(policy.read_write))
    assert _covered(project_home(paths["repos"], "proj-a"), list(policy.read_write))
    assert _covered(paths["scratch"], list(policy.read_write))
    for hidden in (
        paths["theirs"] / "secret.py",
        project_home(paths["repos"], "proj-b"),
        paths["server_home"] / ".claude" / "transcript.jsonl",
        paths["code"] / "server.log",
        paths["code"] / "db.sqlite3",
    ):
        assert not _covered(hidden, granted), hidden
    # Nobody may list the clones, which would name the other projects.
    assert str(os.path.realpath(paths["repos"])) not in policy.list_only
    # WorkPilot's code stays readable; git's identity and transport too.
    assert _covered(paths["code"] / "run.py", list(policy.read_only))
    assert _covered(paths["server_home"] / ".gitconfig", list(policy.read_only))
    assert _covered(paths["server_home"] / ".ssh", list(policy.read_only))
    assert not _covered(paths["code"] / "run.py", list(policy.read_write))


def test_a_listing_never_names_what_is_hidden_below(tmp_path):
    (tmp_path / "a" / "hidden").mkdir(parents=True)
    (tmp_path / "a" / "open").mkdir()
    (tmp_path / "b").mkdir()
    (tmp_path / "b" / "state.db").write_text("", encoding="utf-8")
    (tmp_path / "b" / "code.py").write_text("", encoding="utf-8")
    (tmp_path / "link").symlink_to(tmp_path / "a" / "hidden")

    granted, listable = readable_complement(
        [tmp_path / "a" / "hidden", tmp_path / "b" / "state.db"], tmp_path
    )
    real = Path(os.path.realpath(tmp_path))
    assert real / "a" / "open" in granted
    assert real / "b" / "code.py" in granted
    assert real / "a" / "hidden" not in granted
    assert real / "link" not in granted  # a way around the denial
    assert real / "b" in listable  # only a file is hidden below it
    assert real / "a" not in listable  # a hidden directory is below it
    assert real not in listable


def test_isolation_is_required_unless_turned_off():
    assert isolation_mode({}) == REQUIRED
    assert isolation_mode({ISOLATION_ENV: "anything"}) == REQUIRED
    assert isolation_mode({ISOLATION_ENV: " OFF "}) == OFF


def test_a_run_gets_its_project_home_and_own_temp(tmp_path, monkeypatch):
    paths = _tree(tmp_path)
    monkeypatch.setenv("HOME", str(paths["server_home"]))
    env = {"HOME": "/elsewhere", "TMPDIR": "/tmp", "XDG_CONFIG_HOME": "/x"}
    prefix = prepare_run(
        project_id="proj-a",
        clone=paths["mine"],
        scratch=paths["scratch"],
        repos_root=paths["repos"],
        database_url="postgresql+asyncpg://db/w",
        env=env,
    )
    assert env["HOME"] == str(project_home(paths["repos"], "proj-a"))
    assert env["TMPDIR"].startswith(str(paths["scratch"]))
    assert "XDG_CONFIG_HOME" not in env
    assert env["GIT_CONFIG_GLOBAL"] == str(paths["server_home"] / ".gitconfig")
    assert prefix[-1] == "--" and str(_CONFINE) in prefix
    policy = json.loads((paths["scratch"] / "isolation.json").read_text("utf-8"))
    assert str(os.path.realpath(paths["mine"])) in policy["read_write"]


def test_a_bad_policy_never_starts_the_command(tmp_path):
    marker = tmp_path / "ran"
    policy = tmp_path / "policy.json"
    policy.write_text(json.dumps({"read_only": ["relative/path"]}), encoding="utf-8")
    result = subprocess.run(
        [
            sys.executable,
            "-I",
            str(_CONFINE),
            "--policy",
            str(policy),
            "--",
            sys.executable,
            "-c",
            f"open({str(marker)!r}, 'w').close()",
        ],
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert result.returncode == 78
    assert "run isolation" in result.stderr
    assert not marker.exists()


def test_the_run_manager_confines_each_run_unless_turned_off(tmp_path, monkeypatch):
    from server import config as server_config
    from server.services import run_manager

    paths = _tree(tmp_path)
    monkeypatch.setenv("WORKPILOT_REPOS_ROOT", str(paths["repos"]))
    monkeypatch.delenv(ISOLATION_ENV, raising=False)
    server_config.reset_settings_cache()
    try:
        env: dict[str, str] = {}
        cmd = run_manager._confine(
            ["python", "run.py"], "proj-a", str(paths["mine"]), paths["scratch"], env
        )
        assert cmd[-2:] == ["python", "run.py"] and str(_CONFINE) in cmd
        assert env["HOME"] == str(project_home(paths["repos"], "proj-a"))

        monkeypatch.setenv(ISOLATION_ENV, "off")
        assert run_manager._confine(
            ["python", "run.py"], "proj-a", str(paths["mine"]), paths["scratch"], {}
        ) == ["python", "run.py"]
    finally:
        server_config.reset_settings_cache()


def test_deleting_a_project_deletes_its_run_home(tmp_path, monkeypatch):
    from server import config as server_config
    from server.services.repos import delete_clone

    monkeypatch.setenv("WORKPILOT_REPOS_ROOT", str(tmp_path))
    server_config.reset_settings_cache()
    try:
        home = project_home(tmp_path, "proj-a")
        (home / ".cache").mkdir(parents=True)
        (tmp_path / "proj-a").mkdir()
        delete_clone("proj-a")
        assert not home.exists() and not (tmp_path / "proj-a").exists()
    finally:
        server_config.reset_settings_cache()


_PROBE = """
import os, sys
def attempt(label, action):
    try:
        action()
        print(label, "allowed")
    except OSError:
        print(label, "denied")
attempt("own", lambda: open(sys.argv[1] + "/mine.py").read())
attempt("write-own", lambda: open(sys.argv[1] + "/new.py", "w").write("x"))
attempt("theirs", lambda: open(sys.argv[2] + "/secret.py").read())
attempt("list-clones", lambda: os.listdir(sys.argv[3]))
attempt("server-home", lambda: open(sys.argv[4] + "/.claude/transcript.jsonl").read())
attempt("write-code", lambda: open(sys.argv[5], "a").write(""))
attempt("parent-env", lambda: open("/proc/%d/environ" % os.getppid(), "rb").read())
attempt("home", lambda: open(os.environ["HOME"] + "/memory.md", "w").write("x"))
"""


@pytest.mark.skipif(not is_linux(), reason="Landlock is a Linux module")
def test_a_confined_run_is_refused_the_other_tenant_for_real(tmp_path, monkeypatch):
    paths = _tree(tmp_path)
    monkeypatch.setenv("HOME", str(paths["server_home"]))
    env = dict(os.environ)
    prefix = prepare_run(
        project_id="proj-a",
        clone=paths["mine"],
        scratch=paths["scratch"],
        repos_root=paths["repos"],
        database_url="postgresql+asyncpg://db/w",
        env=env,
    )
    code_file = _BACKEND / "server" / "__init__.py"
    result = subprocess.run(
        [
            *prefix,
            sys.executable,
            "-c",
            _PROBE,
            str(paths["mine"]),
            str(paths["theirs"]),
            str(paths["repos"]),
            str(paths["server_home"]),
            str(code_file),
        ],
        env=env,
        capture_output=True,
        text=True,
        stdin=subprocess.DEVNULL,
        timeout=120,
    )
    assert result.returncode == 0, result.stderr
    verdicts = dict(line.split() for line in result.stdout.splitlines())
    assert verdicts == {
        "own": "allowed",
        "write-own": "allowed",
        "theirs": "denied",
        "list-clones": "denied",
        "server-home": "denied",
        "write-code": "denied",
        # Landlock keeps a run out of another process's environment, unless
        # it holds CAP_SYS_PTRACE: as root it does, which is why the server
        # image runs as an unprivileged user (so does CI).
        "parent-env": "allowed" if os.geteuid() == 0 else "denied",
        "home": "allowed",
    }

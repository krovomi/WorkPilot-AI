"""A Node.js a version manager installed, when the PATH's is too old for REA.

Under WSL, WorkPilot inherits nvm's default alias (26.10.0) while the user's
terminal switched to 27.0.0-alpha: REA said « Node.js too old » although an
accepted release sat in ``~/.nvm/versions/node``. ``node_version`` is
replaced by a table, so no binary runs and the tests hold on every OS.
"""

from __future__ import annotations

import importlib
import json
from pathlib import Path

import pytest
from rea import Pin, ReaLauncher, ReaUnavailable, locate
from rea.node_installs import LAYOUTS_FILE, NodeInstall, managed_installs
from rea.pin import node_satisfies, parse_version

# ``rea.locate`` is also the name of the function the package exports.
LOCATE = importlib.import_module("rea.locate")

ROOT = Path(__file__).resolve().parents[2]
FRONTEND_COPY = (
    ROOT / "apps" / "frontend" / "src" / "shared" / "constants" / "node-installs.json"
)

PIN = Pin(
    package="rea-agents", version="6.9.0", node=("^22.23.4", "^24.22.1", ">=26.12.1")
)


def _binary(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("", encoding="utf-8")
    return path


@pytest.fixture
def versions(monkeypatch):
    """What each fake binary answers to ``--version``."""
    table: dict[str, str] = {}
    monkeypatch.setattr(LOCATE, "node_version", lambda node: table.get(str(node)))
    return table


def test_the_badge_reads_the_same_layouts():
    backend = json.loads(LAYOUTS_FILE.read_text(encoding="utf-8"))
    frontend = json.loads(FRONTEND_COPY.read_text(encoding="utf-8"))
    assert frontend == backend


def test_a_prerelease_counts_as_its_release():
    assert parse_version("v27.0.0-alpha.0.1.0") == (27, 0, 0)
    assert node_satisfies("v27.0.0-alpha.1", PIN.node)
    assert not node_satisfies("v26.10.0", PIN.node)


def test_every_posix_manager_is_read_newest_first(tmp_path: Path):
    home = tmp_path / "home"
    nvm_old = _binary(home / ".nvm/versions/node/v26.10.0/bin/node")
    nvm_new = _binary(home / ".nvm/versions/node/v27.0.0-alpha.0.1.0/bin/node")
    fnm = _binary(
        home / ".local/share/fnm/node-versions/v24.22.1/installation/bin/node"
    )
    volta = _binary(home / ".volta/tools/image/node/22.23.4/bin/node")
    mise = _binary(home / ".local/share/mise/installs/node/26.12.1/bin/node")
    asdf = _binary(home / ".asdf/installs/nodejs/20.0.0/bin/node")
    (home / ".nvm/versions/node/not-a-version").mkdir()
    (home / ".nvm/versions/node/v25.0.0").mkdir()  # no binary inside

    found = managed_installs(home=home, env={}, windows=False)

    assert [Path(i.path) for i in found] == [nvm_new, mise, nvm_old, fnm, volta, asdf]
    assert [i.manager for i in found] == ["nvm", "mise", "nvm", "fnm", "volta", "asdf"]


def test_a_manager_variable_points_at_its_own_directory(tmp_path: Path):
    custom = tmp_path / "elsewhere"
    node = _binary(custom / "versions/node/v26.12.1/bin/node")
    found = managed_installs(
        home=tmp_path / "home", env={"NVM_DIR": str(custom)}, windows=False
    )
    assert [Path(i.path) for i in found] == [node]
    relative = managed_installs(
        home=tmp_path / "home", env={"NVM_DIR": "versions"}, windows=False
    )
    assert relative == []


def test_the_windows_managers_are_read(tmp_path: Path):
    home = tmp_path / "home"
    nvm = _binary(home / "AppData/Roaming/nvm/v26.12.1/node.exe")
    fnm = _binary(
        home / "AppData/Roaming/fnm/node-versions/v24.22.1/installation/node.exe"
    )
    volta = _binary(home / "AppData/Local/Volta/tools/image/node/22.23.4/node.exe")
    found = managed_installs(home=home, env={}, windows=True)
    assert [Path(i.path) for i in found] == [nvm, fnm, volta]


def test_the_path_node_wins_when_it_is_accepted(versions):
    versions["/usr/bin/node"] = "24.22.1"
    other = NodeInstall(
        "/home/me/.nvm/versions/node/v27.0.0/bin/node", (27, 0, 0), "nvm"
    )
    versions[other.path] = "27.0.0"
    found = locate(PIN, node="/usr/bin/node", rea="", installs=[other])
    assert isinstance(found, ReaLauncher) or found.reason == "npx_missing"
    if isinstance(found, ReaLauncher):
        assert found.argv[0] == "/usr/bin/node" and found.node_manager is None


def test_a_too_old_path_node_falls_back_to_a_managed_release(tmp_path: Path, versions):
    old = str(_binary(tmp_path / "nvm/v26.10.0/bin/node"))
    new_path = _binary(tmp_path / "nvm/v27.0.0-alpha.0.1.0/bin/node")
    new = str(new_path)
    versions[old] = "26.10.0"
    versions[new] = "27.0.0"
    entry = new_path.parent / "node_modules" / "rea-agents" / "scripts" / "rea.mjs"
    _binary(entry)
    (entry.parent.parent / "package.json").write_text(
        json.dumps({"name": "rea-agents", "version": "6.9.0"}), encoding="utf-8"
    )
    installs = [
        NodeInstall(new, (27, 0, 0), "nvm"),
        NodeInstall(old, (26, 10, 0), "nvm"),
    ]

    found = locate(PIN, node=old, installs=installs)

    assert isinstance(found, ReaLauncher)
    assert found.argv == (new, str(entry))
    assert found.source == "installed"
    assert (found.node_version, found.node_manager) == ("27.0.0", "nvm")


def test_a_directory_name_is_checked_by_running_the_binary(tmp_path: Path, versions):
    versions["/usr/bin/node"] = "20.0.0"
    liar = NodeInstall(str(tmp_path / "v30.0.0/bin/node"), (30, 0, 0), "nvm")
    versions[liar.path] = "18.0.0"
    found = locate(PIN, node="/usr/bin/node", rea="", installs=[liar])
    assert isinstance(found, ReaUnavailable)
    assert found.reason == "node_too_old"
    assert "found 20.0.0" in found.detail


def test_without_a_path_node_a_managed_one_is_enough(tmp_path: Path, versions):
    managed = NodeInstall(str(tmp_path / "v24.22.1/bin/node"), (24, 22, 1), "fnm")
    versions[managed.path] = "24.22.1"
    found = locate(PIN, node=None, rea="", installs=[managed])
    if isinstance(found, ReaUnavailable):  # no npx beside the fake binary
        assert found.reason == "npx_missing"
    else:
        assert found.argv[0] == managed.path


def test_nothing_accepted_anywhere_is_missing_or_too_old(versions, monkeypatch):
    monkeypatch.setattr(LOCATE, "find_executable", lambda name: None)
    found = locate(PIN, installs=[])
    assert isinstance(found, ReaUnavailable)
    assert found.reason == "node_missing"

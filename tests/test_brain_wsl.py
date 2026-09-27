"""The brain folder, chosen from WorkPilot running under WSL.

What has to hold:

* **a Windows spelling is the folder the person meant** — ``C:\\Users\\…`` and
  ``\\\\wsl$\\<distro>\\…`` become the paths this Linux process opens, and
  nothing is converted outside WSL;
* **the Windows profile is a home directory**, so a vault kept by the Windows
  Obsidian app can be plugged in — and nothing else under the drive mount is:
  ``C:\\Windows`` stays refused;
* the settings tell the UI it runs under WSL and which folders are allowed.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from brain import api, wsl  # noqa: E402


@pytest.fixture
def home(tmp_path, monkeypatch):
    home = tmp_path / "home" / "thomas"
    home.mkdir(parents=True)
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("WORKPILOT_BRAIN_CONFIG", str(home / "brain.json"))
    monkeypatch.delenv("WORKPILOT_BRAIN_DIR", raising=False)
    monkeypatch.delenv("BRAIN_ENABLED", raising=False)
    return home


@pytest.fixture
def under_wsl(tmp_path, monkeypatch):
    """WSL, with drives under ``<tmp>/mnt/`` and a Windows profile ``Thomas``."""
    mount = tmp_path / "mnt"
    profile = mount / "c" / "Users" / "Thomas"
    profile.mkdir(parents=True)
    (mount / "c" / "Windows").mkdir()
    monkeypatch.setattr(wsl, "is_wsl", lambda: True)
    monkeypatch.setattr(api, "is_wsl", lambda: True)
    monkeypatch.setattr(wsl, "automount_root", lambda: str(mount) + "/")
    monkeypatch.setattr(api, "automount_root", lambda: str(mount) + "/")
    monkeypatch.setattr(wsl, "windows_home", lambda: str(profile))
    monkeypatch.setenv("WSL_DISTRO_NAME", "Ubuntu")
    return mount


def test_nothing_is_converted_outside_wsl(monkeypatch):
    monkeypatch.setattr(wsl, "is_wsl", lambda: False)
    assert wsl.to_wsl_path("C:\\Users\\Thomas") == "C:\\Users\\Thomas"


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("C:\\Users\\Thomas\\Vault", "c/Users/Thomas/Vault"),
        ("C:/Users/Thomas/Vault/", "c/Users/Thomas/Vault"),
        ("d:\\Notes", "d/Notes"),
        ("E:", "e"),
    ],
)
def test_a_drive_path_is_read_under_the_mount_root(under_wsl, raw, expected):
    assert wsl.to_wsl_path(raw) == str(under_wsl) + "/" + expected


def test_a_unc_path_of_this_distribution_is_a_linux_path(under_wsl):
    assert wsl.to_wsl_path("\\\\wsl$\\Ubuntu\\home\\thomas\\v") == "/home/thomas/v"
    assert wsl.to_wsl_path("\\\\wsl.localhost\\ubuntu\\home\\x") == "/home/x"
    # another distribution's files are not at that path here
    other = "\\\\wsl$\\Debian\\home\\x"
    assert wsl.to_wsl_path(other) == other


def test_a_linux_path_is_left_alone(under_wsl):
    assert wsl.to_wsl_path("/home/thomas/vault") == "/home/thomas/vault"


def test_the_windows_profile_is_a_home_root(home, under_wsl):
    assert wsl.home_roots() == [str(home), str(under_wsl / "c" / "Users" / "Thomas")]


def test_a_windows_vault_is_accepted(home, under_wsl):
    target, code = api._home_path("C:\\Users\\Thomas\\Documents\\MonVault")
    assert code is None
    assert target == under_wsl / "c" / "Users" / "Thomas" / "Documents" / "MonVault"


def test_the_mounted_spelling_is_accepted_too(home, under_wsl):
    raw = str(under_wsl / "c" / "Users" / "Thomas" / "Obsidian")
    target, code = api._home_path(raw)
    assert code is None and str(target) == raw


def test_the_drive_is_case_insensitive(home, under_wsl):
    target, code = api._home_path("c:\\users\\thomas\\Vault")
    assert code is None and target is not None


@pytest.mark.parametrize(
    "raw",
    ["C:\\Windows\\System32", "C:\\Users\\Thomas", "C:\\Users\\Other\\Vault", "C:\\"],
)
def test_the_rest_of_the_drive_stays_refused(home, under_wsl, raw):
    assert api._home_path(raw) == (None, "outside-home")


def test_the_linux_home_still_works(home, under_wsl):
    target, code = api._home_path(str(home / "brain"))
    assert code is None and target == home / "brain"


def test_the_saved_windows_path_is_where_the_brain_is(home, under_wsl, monkeypatch):
    from brain.home import brain_dir, write_config

    write_config(path="C:\\Users\\Thomas\\Vault")
    assert brain_dir() == under_wsl / "c" / "Users" / "Thomas" / "Vault"
    monkeypatch.setenv("WORKPILOT_BRAIN_DIR", "C:\\Users\\Thomas\\Other")
    assert brain_dir() == under_wsl / "c" / "Users" / "Thomas" / "Other"


def test_the_api_plugs_a_windows_folder_and_says_it_runs_under_wsl(home, under_wsl):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    app = FastAPI()
    app.include_router(api.router)
    client = TestClient(app)

    raw = "C:\\Users\\Thomas\\Documents\\MonVault"
    reply = client.post(
        "/api/brain/settings", json={"path": raw, "connect": False}
    ).json()
    assert reply["success"], reply
    settings = reply["settings"]
    assert settings["path"] == str(
        under_wsl / "c" / "Users" / "Thomas" / "Documents" / "MonVault"
    )
    assert settings["wsl"] is True
    assert str(under_wsl / "c" / "Users" / "Thomas") in settings["homeRoots"]

    refused = client.post(
        "/api/brain/settings", json={"path": "C:\\Windows\\Temp", "connect": False}
    ).json()
    assert refused["code"] == "outside-home"
    assert not os.path.exists(under_wsl / "c" / "Windows" / "Temp")

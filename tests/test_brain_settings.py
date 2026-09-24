"""Settings for the shared brain, and the Kanban card's view of one task.

What has to hold:

* **plugging an Obsidian vault adds nothing a person sees** — no README, no
  generated note at its root — and its notes become the brain's notes;
* **a GitHub repository is cloned**, and a clone that fails says why instead of
  leaving an empty brain behind;
* **the folder stays under the home directory**, and **a remote is a remote**:
  the local API is reachable from a browser, and git treats ``-…`` as an option;
* **the task card sees what agents wrote during that task**, and a person can
  activate or turn down what they proposed.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from brain import Brain  # noqa: E402
from brain.learn import project_name_from, record_build, task_ref  # noqa: E402
from brain.sync import normalize_remote  # noqa: E402

needs_git = pytest.mark.skipif(
    shutil.which("git") is None, reason="git is not installed"
)


@pytest.fixture
def home(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))
    monkeypatch.setenv("APPDATA", str(home / "AppData"))
    monkeypatch.setenv("WORKPILOT_BRAIN_CONFIG", str(home / "brain.json"))
    monkeypatch.setenv("WORKPILOT_BRAIN_HOME", str(home))
    monkeypatch.delenv("WORKPILOT_BRAIN_DIR", raising=False)
    monkeypatch.delenv("BRAIN_ENABLED", raising=False)
    monkeypatch.setenv("BRAIN_PULL_INTERVAL", "0")
    return home


@pytest.fixture
def client(home):
    from brain.api import router
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def _vault(home: Path) -> Path:
    vault = home / "Documents" / "MonVault"
    (vault / ".obsidian").mkdir(parents=True)
    (vault / "Idées.md").write_text(
        "# Idées\n\nLien vers [[Projets]].\n", encoding="utf-8"
    )
    (vault / "Projets.md").write_text("# Projets\n\n#travail\n", encoding="utf-8")
    return vault


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------


def test_default_settings_describe_an_absent_brain(client, home):
    settings = client.get("/api/brain/settings").json()["settings"]
    assert settings["source"] == "default"
    assert settings["exists"] is False and settings["active"] is False
    assert settings["enabled"] is True


@needs_git
def test_plugging_an_obsidian_vault_adopts_it_without_writing_at_its_root(client, home):
    vault = _vault(home)
    before = sorted(p.name for p in vault.iterdir())
    reply = client.post("/api/brain/settings", json={"path": str(vault)}).json()

    assert reply["success"], reply
    assert reply["result"]["adopted"] is True
    settings = reply["settings"]
    assert settings["source"] == "config" and settings["path"] == str(vault)
    assert settings["obsidianVault"] is True and settings["active"] is True
    after = sorted(
        p.name
        for p in vault.iterdir()
        if p.name not in (".git", ".gitignore", "graphify-out")
    )
    new = set(after) - set(before)
    assert new <= {".workpilot-brain", "skills"}, new
    assert (
        not (vault / "README.md").exists() and not (vault / "INSTRUCTIONS.md").exists()
    )
    # the vault's own notes are the brain's notes now
    hits = Brain(vault).recall("idées")["hits"]
    assert hits and hits[0]["source_file"] == "Idées.md"


def test_the_folder_must_be_under_home(client, home, tmp_path):
    outside = tmp_path / "elsewhere"
    reply = client.post("/api/brain/settings", json={"path": str(outside)}).json()
    assert reply["success"] is False and reply["code"] == "outside-home"
    assert not outside.exists()


def test_an_environment_variable_wins_over_settings(client, home, monkeypatch):
    monkeypatch.setenv("WORKPILOT_BRAIN_DIR", str(home / "from-env"))
    reply = client.post("/api/brain/settings", json={"path": str(home / "x")}).json()
    assert reply["success"] is False and reply["code"] == "env-locked"
    assert reply["settings"]["source"] == "env"


def test_the_switch_is_saved(client, home):
    client.post("/api/brain/settings", json={"enabled": False, "connect": False})
    assert (
        json.loads((home / "brain.json").read_text(encoding="utf-8"))["enabled"]
        is False
    )
    assert client.get("/api/brain/settings").json()["settings"]["enabled"] is False


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("krovomi/brain", "https://github.com/krovomi/brain.git"),
        ("krovomi/brain.git", "https://github.com/krovomi/brain.git"),
        ("git@github.com:krovomi/brain.git", "git@github.com:krovomi/brain.git"),
        (
            "https://github.com/krovomi/brain.git",
            "https://github.com/krovomi/brain.git",
        ),
    ],
)
def test_remotes_are_normalized(value, expected):
    assert normalize_remote(value) == expected


@pytest.mark.parametrize(
    "value",
    [
        "--upload-pack=touch /tmp/pwned",
        "-c core.sshCommand=x",
        "ext::sh -c touch% /tmp/x",
        "",
        "not a remote",
    ],
)
def test_what_git_would_run_is_not_a_remote(value):
    with pytest.raises(ValueError):
        normalize_remote(value)


def test_a_bad_remote_is_refused_by_the_api(client, home):
    reply = client.post(
        "/api/brain/settings",
        json={"path": str(home / "b"), "remote": "--upload-pack=x"},
    ).json()
    assert reply["success"] is False and reply["code"] == "invalid-remote"
    assert not (home / "b").exists()


@needs_git
def test_a_github_style_remote_is_cloned(client, home, tmp_path):
    # A brain already on "GitHub" (a bare repository here), made on another machine.
    remote = tmp_path / "remote.git"
    subprocess.run(["git", "init", "-q", "--bare", str(remote)], check=True)
    other = Brain(tmp_path / "other-machine")
    other.init(remote=str(remote))
    other.write("Décision", "On garde PostgreSQL.")

    target = home / "brain-clone"
    reply = client.post(
        "/api/brain/settings", json={"path": str(target), "remote": str(remote)}
    ).json()
    assert reply["success"], reply
    assert reply["result"]["cloned"] is True
    assert reply["settings"]["remote"] == str(remote)
    assert (target / "knowledge" / "decision.md").is_file()


@needs_git
def test_a_clone_that_fails_says_why(client, home, tmp_path):
    from brain.api import _clone_error
    from brain.sync import clone

    missing = tmp_path / "missing.git"
    # git's own words, kept in the assertion message: they differ between
    # platforms, and this is what a person reads when the classifier misses one.
    message = clone(str(missing), tmp_path / "probe")
    assert message, "cloning a missing repository must fail"
    assert _clone_error(message) == "not-found", message

    reply = client.post(
        "/api/brain/settings",
        json={"path": str(home / "nothing"), "remote": str(missing)},
    ).json()
    assert reply["success"] is False and reply["code"] == "not-found"
    # git's own words come back as `detail`: the remote is the one the person
    # typed, and "which repository, and what git said" is what they need.
    assert "missing.git" in (reply["detail"] or "")
    assert reply["settings"]["exists"] is False


# ---------------------------------------------------------------------------
# The task card
# ---------------------------------------------------------------------------


def test_project_names_are_read_from_strings_only():
    assert project_name_from("/home/me/shop") == "shop"
    assert project_name_from("C:\\Users\\me\\shop") == "shop"
    assert project_name_from("/x/shop/.workpilot/worktrees/001-auth") == "shop"


def test_task_ref_names_only_real_specs(tmp_path):
    project = tmp_path / "shop"
    assert (
        task_ref(project, project / ".workpilot" / "specs" / "001-auth")
        == "shop/001-auth"
    )
    assert task_ref(project, project / "somewhere") is None
    assert task_ref(project, None) is None


@needs_git
def test_the_task_card_lists_what_was_learned_during_the_task(client, home):
    brain = Brain(home / "brain")
    client.post("/api/brain/settings", json={"path": str(brain.root)})
    project = home / "shop"
    spec_dir = project / ".workpilot" / "specs" / "001-auth"
    spec_dir.mkdir(parents=True)
    (spec_dir / "spec.md").write_text(
        "# Specification: Auth JWT\n\nAjouter JWT.\n", encoding="utf-8"
    )

    ref = task_ref(project, spec_dir)
    brain.write(
        "Rotation des clés",
        "Tous les 30 jours.",
        agent="coder",
        trusted=False,
        task=ref,
    )
    brain.remember(
        "Toujours signer les JWT en RS256", agent="coder", trusted=False, task=ref
    )
    brain.write("Sans rapport", "Autre tâche.", task="shop/002-other")
    record_build(spec_dir, project, qa_approved=True, tests_passed=True, brain=brain)

    learning = client.get(
        "/api/brain/task", params={"project_dir": str(project), "spec_id": "001-auth"}
    ).json()["learning"]
    assert learning["active"] is True
    assert learning["build"]["title"] == "Auth JWT" and learning["build"]["qa"] is True
    titles = {n["title"] for n in learning["notes"]}
    assert "Rotation des clés" in titles and "Sans rapport" not in titles
    [proposal] = learning["proposals"]
    assert proposal["status"] == "proposed"
    assert Path(proposal["absPath"]).is_file()

    # the note links to the build note: one graph neighbourhood per task
    rotation = next(n for n in learning["notes"] if n["title"] == "Rotation des clés")
    neighbours = {
        x["id"] for x in brain.graph().get_node(rotation["path"][:-3])["neighbors"]
    }
    assert "knowledge/projects/shop/builds/001-auth" in neighbours

    activated = client.post(
        "/api/brain/instruction", json={"path": proposal["path"], "status": "active"}
    ).json()
    assert activated["success"] and activated["status"] == "active"
    again = client.get(
        "/api/brain/task", params={"project_dir": str(project), "spec_id": "001-auth"}
    ).json()["learning"]
    assert again["proposals"] == []


def test_the_task_card_is_empty_without_a_brain(client, home):
    learning = client.get(
        "/api/brain/task", params={"project_dir": "/x/shop", "spec_id": "001"}
    ).json()["learning"]
    assert learning["active"] is False and learning["notes"] == []


def test_instruction_paths_cannot_leave_the_brain(client, home):
    Brain(home / "brain").root.mkdir(parents=True)
    client.post("/api/brain/settings", json={"path": str(home / "brain")})
    reply = client.post(
        "/api/brain/instruction", json={"path": "../../etc/passwd", "status": "active"}
    ).json()
    assert reply["success"] is False and reply["code"] == "invalid-path"


@pytest.mark.parametrize(
    ("stderr", "code"),
    [
        ("git@github.com: Permission denied (publickey).", "auth"),
        ("fatal: could not read Username for 'https://github.com'", "auth"),
        ("remote: Repository not found.", "not-found"),
        (
            "fatal: 'C:/Users/x/missing.git' does not appear to be a git repository",
            "not-found",
        ),
        ("fatal: unable to access 'https://x/': Could not resolve host: x", "network"),
        ("git clone timed out", "timeout"),
        (
            "fatal: Unable to create '/v/.git/index.lock': File exists. "
            "Another git process seems to be running",
            "locked",
        ),
        ("Author identity unknown *** Please tell me who you are.", "identity"),
        (" ! [rejected]        main -> main (fetch first)", "rejected"),
        ("error: unable to create file a/b.md: Filename too long", "path-too-long"),
        ("something else", "failed"),
    ],
)
def test_clone_failures_become_codes_the_ui_translates(stderr, code):
    from brain.api import _clone_error

    assert _clone_error(stderr) == code


def test_the_home_directory_itself_is_not_a_brain_folder(client, home):
    reply = client.post("/api/brain/settings", json={"path": str(home)}).json()
    assert reply["code"] == "outside-home"


# ---------------------------------------------------------------------------
# A real Obsidian vault: YAML a person wrote, not frontmatter we wrote
# ---------------------------------------------------------------------------


def _daily_note_vault(home: Path) -> Path:
    vault = _vault(home)
    (vault / "Daily").mkdir()
    (vault / "Daily" / "2024-01-01.md").write_text(
        "---\n"
        "date: 2024-01-01\n"
        "created: 2024-01-01T10:00:00\n"
        "tags: [2024, journal, null]\n"
        "tasks: shop/001-auth\n"
        "---\n"
        "# Jour 1\n\n[[Projets]]\n",
        encoding="utf-8",
    )
    return vault


@needs_git
def test_a_vault_with_yaml_dates_can_be_plugged_and_synced(client, home):
    # Obsidian's daily notes and properties write `date: 2024-01-01`, which
    # YAML reads as a date object: it used to make graph.json unwritable, and
    # both the settings save and the sync answered 500 ("Failed to fetch").
    vault = _daily_note_vault(home)
    reply = client.post("/api/brain/settings", json={"path": str(vault)}).json()
    assert reply["success"], reply
    synced = client.post("/api/brain/sync", json={})
    assert synced.status_code == 200

    graph = json.loads(
        (vault / "graphify-out" / "graph.json").read_text(encoding="utf-8")
    )
    node = next(n for n in graph["nodes"] if n["id"] == "Daily/2024-01-01")
    assert node["metadata"]["created"] == "2024-01-01T10:00:00"
    assert node["metadata"]["tasks"] == ["shop/001-auth"]
    assert "tag:none" not in {n["id"] for n in graph["nodes"]}
    assert "tag:2024" in {n["id"] for n in graph["nodes"]}


@needs_git
def test_a_sync_the_remote_refuses_says_why(client, home, tmp_path):
    vault = _vault(home)
    client.post("/api/brain/settings", json={"path": str(vault)})
    subprocess.run(
        ["git", "remote", "add", "origin", str(tmp_path / "missing.git")],
        cwd=vault,
        check=True,
    )
    reply = client.post("/api/brain/sync", json={}).json()
    assert reply["success"] is False and reply["code"] == "not-found", reply


def test_an_unexpected_error_is_an_answer_not_a_500(client, home, monkeypatch):
    # A 500 leaves without CORS headers: the renderer reads "Failed to fetch".
    import brain.api as api

    def boom(self, *args, **kwargs):
        raise TypeError("a bug nobody planned for")

    monkeypatch.setattr(api.Brain, "sync", boom)
    monkeypatch.setattr(api.Brain, "init", boom)
    synced = client.post("/api/brain/sync", json={})
    assert synced.status_code == 200 and synced.json()["code"] == "sync-failed"
    saved = client.post("/api/brain/settings", json={"path": str(home / "b")})
    assert saved.status_code == 200 and saved.json()["code"] == "failed"


def test_git_detail_is_one_line_without_credentials():
    from brain.api import _git_detail

    detail = _git_detail(
        "To https://tom:ghp_secret@github.com/k/v.git\n"
        " ! [rejected]        main -> main (fetch first)\n"
        "hint: Updates were rejected because the remote contains work"
    )
    assert "ghp_secret" not in detail and "tom" not in detail
    assert "\n" not in detail and "hint" not in detail
    assert "[rejected]" in detail


@needs_git
def test_a_failed_sync_shows_what_git_said(client, home, tmp_path):
    vault = _vault(home)
    client.post("/api/brain/settings", json={"path": str(vault)})
    subprocess.run(
        ["git", "remote", "add", "origin", str(tmp_path / "missing.git")],
        cwd=vault,
        check=True,
    )
    reply = client.post("/api/brain/sync", json={}).json()
    assert reply["step"] == "fetch"
    assert reply["detail"] and "missing.git" in reply["detail"]

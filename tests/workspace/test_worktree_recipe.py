"""The worktree recipe (killer feature F8): what a new worktree gets before the first session.

Detection per stack, the file's rules (argument lists, no shell, paths inside
the project), approval by digest, a failing step that the task survives and
the agent reads, disjoint port blocks, teardown before removal, and the files
an agent may not write.
"""

from __future__ import annotations

import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest
from core.workspace import ports as ports_mod
from core.workspace import recipe as recipe_mod
from core.workspace.ports import release_ports, reserve_ports, reserved_port
from core.workspace.recipe import detect_recipe, load_recipe, parse_recipe, recipe_for
from core.workspace.recipe_api import render_toml
from core.workspace.recipe_run import (
    approve_recipe,
    is_approved,
    prepare_worktree,
    read_setup_record,
    setup_prompt_section,
    teardown_worktree,
)
from core.workspace.workspace_setup import is_workpilot_repo
from security.path_guard import protected_config_target

PY = sys.executable


@pytest.fixture(autouse=True)
def _recipe_on(monkeypatch, tmp_path):
    monkeypatch.delenv("WORKPILOT_WORKTREE_SETUP", raising=False)
    monkeypatch.setenv("WORKPILOT_DATA_DIR", str(tmp_path / "data"))


def _git_init(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "init", "-q"], cwd=path, check=True)
    return path


def _write_recipe(project: Path, text: str) -> None:
    (project / ".workpilot").mkdir(parents=True, exist_ok=True)
    (project / ".workpilot" / "worktree.toml").write_text(text, encoding="utf-8")


def _toml_cmd(*args: str) -> str:
    return "[" + ", ".join(f"'{a}'" for a in args) + "]"


# ── detection, every stack ───────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("files", "expected"),
    [
        (
            {"package.json": "{}", "pnpm-lock.yaml": ""},
            [("pnpm", "install", "--frozen-lockfile")],
        ),
        ({"package.json": "{}", "yarn.lock": ""}, [("yarn", "install")]),
        ({"package.json": "{}", "bun.lock": ""}, [("bun", "install")]),
        ({"package.json": "{}", "package-lock.json": "{}"}, [("npm", "ci")]),
        ({"package.json": "{}"}, [("npm", "install")]),
        ({"uv.lock": ""}, [("uv", "sync")]),
        ({"poetry.lock": ""}, [("poetry", "install")]),
        ({"go.mod": "module x"}, [("go", "mod", "download")]),
        ({"Cargo.toml": ""}, [("cargo", "fetch")]),
        ({"composer.json": "{}"}, [("composer", "install", "--no-interaction")]),
        ({"Gemfile": ""}, [("bundle", "install")]),
        (
            {"pubspec.yaml": "dependencies:\n  flutter:\n    sdk: flutter\n"},
            [("flutter", "pub", "get")],
        ),
        ({"pubspec.yaml": "name: cli\n"}, [("dart", "pub", "get")]),
        ({"pom.xml": "<project/>"}, [("mvn", "-q", "dependency:go-offline")]),
    ],
)
def test_detect_recipe_names_the_stack_package_manager(tmp_path, files, expected):
    for name, content in files.items():
        (tmp_path / name).write_text(content, encoding="utf-8")
    recipe = detect_recipe(tmp_path)
    assert recipe.source == "detected"
    assert list(recipe.setup) == expected


def test_detect_recipe_dotnet_nested_solution_and_tools(tmp_path):
    (tmp_path / "src" / "Api").mkdir(parents=True)
    (tmp_path / "src" / "Api" / "Api.csproj").write_text("<Project/>", encoding="utf-8")
    (tmp_path / ".config").mkdir()
    (tmp_path / ".config" / "dotnet-tools.json").write_text("{}", encoding="utf-8")
    assert list(detect_recipe(tmp_path).setup) == [
        ("dotnet", "restore"),
        ("dotnet", "tool", "restore"),
    ]


def test_detect_recipe_polyglot_gets_one_step_per_manager(tmp_path):
    (tmp_path / "App.sln").write_text("", encoding="utf-8")
    (tmp_path / "package.json").write_text("{}", encoding="utf-8")
    (tmp_path / "package-lock.json").write_text("{}", encoding="utf-8")
    (tmp_path / "requirements.txt").write_text("flask\n", encoding="utf-8")
    steps = list(detect_recipe(tmp_path).setup)
    assert ("npm", "ci") in steps
    assert ("dotnet", "restore") in steps
    assert steps[steps.index(("python", "-m", "venv", ".venv")) + 1][1:] == (
        "-m",
        "pip",
        "install",
        "-r",
        "requirements.txt",
    )


def test_detect_recipe_gradle_wrapper_follows_the_platform(tmp_path, monkeypatch):
    (tmp_path / "gradlew").write_text("", encoding="utf-8")
    (tmp_path / "gradlew.bat").write_text("", encoding="utf-8")
    monkeypatch.setattr(recipe_mod, "is_windows", lambda: True)
    assert detect_recipe(tmp_path).setup[0][0] == "gradlew.bat"
    monkeypatch.setattr(recipe_mod, "is_windows", lambda: False)
    assert detect_recipe(tmp_path).setup[0][0] == "./gradlew"


def test_nothing_recognised_is_an_empty_recipe_with_a_note(tmp_path):
    recipe = detect_recipe(tmp_path)
    assert recipe.empty and recipe.notes


# ── the file ─────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "command",
    [
        "'npm ci && rm -rf /'",
        _toml_cmd("bash", "-c", "npm ci"),
        _toml_cmd("sh", "-c", "x"),
        _toml_cmd("cmd", "/c", "npm ci"),
        _toml_cmd("cmd.exe", "/C", "npm ci"),
        _toml_cmd("pwsh", "-Command", "npm ci"),
        _toml_cmd("powershell.exe", "-EncodedCommand", "AAAA"),
        _toml_cmd("/usr/bin/bash", "-c", "x"),
        "[]",
    ],
)
def test_a_command_that_runs_a_string_is_refused(command):
    recipe = parse_recipe(f"[setup]\ncommands = [{command}]\n")
    assert recipe.errors
    assert recipe.setup == ()


@pytest.mark.parametrize(
    "path", ["/etc/passwd", "../secrets.env", "C:/x.env", "a/../../b"]
)
def test_copy_paths_must_stay_inside_the_project(path):
    recipe = parse_recipe(f"[setup]\ncopy = ['{path}']\n")
    assert recipe.errors


@pytest.mark.parametrize(
    "text",
    [
        "[setup]\ntimeout_seconds = 5\n",
        "[setup]\ntimeout_seconds = 99999\n",
        "[ports]\ncount = 21\n",
        "[ports]\ncount = true\n",
        "[setup]\npass_env = ['NOT A NAME']\n",
        "[install]\ncommands = []\n",
        "setup = 3\n",
        "not toml [",
    ],
)
def test_out_of_range_or_unknown_fields_invalidate_the_whole_recipe(text):
    recipe = parse_recipe(text)
    assert recipe.errors
    assert recipe.empty


def test_a_valid_file_and_its_windows_commands(monkeypatch):
    text = (
        "[setup]\n"
        "commands = [['npm', 'ci'], ['dotnet', 'restore']]\n"
        "windows = [['npm.cmd', 'ci']]\n"
        "copy = ['.env.local', 'config/appsettings.Development.json']\n"
        "pass_env = ['NUGET_TOKEN']\n"
        "timeout_seconds = 600\n"
        "[ports]\ncount = 3\n"
        "[teardown]\ncommands = [['docker', 'compose', 'down']]\n"
    )
    monkeypatch.setattr(recipe_mod, "is_windows", lambda: False)
    recipe = parse_recipe(text)
    assert not recipe.errors
    assert recipe.setup == (("npm", "ci"), ("dotnet", "restore"))
    assert recipe.copy == (".env.local", "config/appsettings.Development.json")
    assert recipe.ports == 3 and recipe.timeout_seconds == 600
    monkeypatch.setattr(recipe_mod, "is_windows", lambda: True)
    assert parse_recipe(text).setup == (("npm.cmd", "ci"),)


def test_the_file_wins_over_detection(tmp_path):
    (tmp_path / "package.json").write_text("{}", encoding="utf-8")
    assert recipe_for(tmp_path).source == "detected"
    _write_recipe(tmp_path, "[setup]\ncommands = [['make', 'deps']]\n")
    assert recipe_for(tmp_path).source == "file"
    assert load_recipe(tmp_path).setup == (("make", "deps"),)


def test_rendered_toml_parses_back_to_the_same_commands():
    commands = (("npm", "ci"), ("dotnet", "restore"), (".venv/bin/python", "-m", "pip"))
    recipe = parse_recipe(render_toml(commands))
    assert not recipe.errors
    assert recipe.setup == commands


# ── approval and running ─────────────────────────────────────────────────────


def _script(project: Path, name: str, body: str) -> str:
    path = project / name
    path.write_text(body, encoding="utf-8")
    return name


def test_a_file_recipe_runs_only_once_approved_as_it_is(tmp_path):
    project, worktree = _git_init(tmp_path / "p"), tmp_path / "wt"
    worktree.mkdir()
    marker = worktree / "ran.txt"
    run = _script(worktree, "run.py", "open('ran.txt', 'w').write('1')\n")
    _write_recipe(project, f"[setup]\ncommands = [{_toml_cmd(PY, run)}]\n")
    report = prepare_worktree(project, worktree, "001-a")
    assert report.status == "awaiting-approval"
    assert not marker.exists()
    assert "not approved" in setup_prompt_section(worktree)

    approve_recipe(project)
    assert is_approved(project, recipe_for(project))
    assert prepare_worktree(project, worktree, "001-a").status == "ready"
    assert marker.read_text(encoding="utf-8") == "1"

    # Changing a single character withdraws the approval.
    _write_recipe(project, "[setup]\ncommands = [['make', 'other']]\n")
    assert not is_approved(project, recipe_for(project))


def test_an_invalid_recipe_cannot_be_approved(tmp_path):
    _write_recipe(tmp_path, "[setup]\ncommands = ['npm ci']\n")
    with pytest.raises(ValueError):
        approve_recipe(tmp_path)


def test_a_failing_step_leaves_the_task_going_and_reaches_the_prompt(tmp_path):
    project, worktree = _git_init(tmp_path / "p"), tmp_path / "wt"
    worktree.mkdir()
    fail = _script(
        worktree,
        "fail.py",
        "import sys\nprint('restore failed: feed 401')\nsys.exit(3)\n",
    )
    ok = _script(worktree, "ok.py", "open('second.txt','w').write('ok')\n")
    _write_recipe(
        project,
        f"[setup]\ncommands = [{_toml_cmd(PY, fail)}, {_toml_cmd(PY, ok)}, "
        f"{_toml_cmd('definitely-not-installed-xyz', 'go')}]\n",
    )
    approve_recipe(project)
    report = prepare_worktree(project, worktree, "002-b")

    assert report.status == "partial"
    assert [s.status for s in report.steps] == ["failed", "ok", "skipped"]
    assert "exit 3" in report.steps[0].detail
    assert (worktree / "second.txt").exists()  # the next step still ran
    section = setup_prompt_section(worktree)
    assert "## Worktree environment" in section
    assert "failed" in section and "feed 401" in section
    assert "definitely-not-installed-xyz" in section
    assert "restore failed" in (
        worktree / ".workpilot" / "worktree-setup.log"
    ).read_text(encoding="utf-8")


def test_a_recipe_that_already_ran_is_not_run_again(tmp_path):
    project, worktree = _git_init(tmp_path / "p"), tmp_path / "wt"
    worktree.mkdir()
    count = _script(
        worktree,
        "count.py",
        "p='n.txt'\nimport os\nn=int(open(p).read()) if os.path.exists(p) else 0\nopen(p,'w').write(str(n+1))\n",
    )
    _write_recipe(project, f"[setup]\ncommands = [{_toml_cmd(PY, count)}]\n")
    approve_recipe(project)
    prepare_worktree(project, worktree, "003-c")
    prepare_worktree(project, worktree, "003-c")
    assert (worktree / "n.txt").read_text(encoding="utf-8") == "1"


def test_commands_get_no_credential_unless_the_recipe_names_it(tmp_path, monkeypatch):
    project, worktree = _git_init(tmp_path / "p"), tmp_path / "wt"
    worktree.mkdir()
    monkeypatch.setenv("GITHUB_TOKEN", "placeholder-not-a-secret")
    monkeypatch.setenv("NUGET_FEED_TOKEN", "placeholder-feed")
    dump = _script(
        worktree,
        "dump.py",
        "import os\nopen('env.txt','w').write("
        "os.environ.get('GITHUB_TOKEN','-')+'|'+os.environ.get('NUGET_FEED_TOKEN','-')"
        "+'|'+os.environ.get('WORKPILOT_TASK_SLUG',''))\n",
    )
    _write_recipe(
        project,
        f"[setup]\ncommands = [{_toml_cmd(PY, dump)}]\npass_env = ['NUGET_FEED_TOKEN']\n",
    )
    approve_recipe(project)
    prepare_worktree(project, worktree, "004-Café")
    github, feed, slug = (worktree / "env.txt").read_text(encoding="utf-8").split("|")
    assert github == "-"
    assert feed == "placeholder-feed"
    assert slug == "004-caf-"


def test_ports_are_reserved_expanded_and_given_to_the_agent(tmp_path):
    project, worktree = _git_init(tmp_path / "p"), tmp_path / "wt"
    worktree.mkdir()
    show = _script(
        worktree, "port.py", "import sys\nopen('port.txt','w').write(sys.argv[1])\n"
    )
    _write_recipe(
        project,
        f"[setup]\ncommands = [{_toml_cmd(PY, show, '${WORKPILOT_PORT}')}]\n[ports]\ncount = 2\n",
    )
    approve_recipe(project)
    report = prepare_worktree(project, worktree, "005-d")
    assert report.port is not None and report.port_count == 2
    assert (worktree / "port.txt").read_text(encoding="utf-8") == str(report.port)
    assert f"{report.port}–{report.port + 1}" in setup_prompt_section(worktree)


def test_only_git_ignored_files_are_copied_in(tmp_path):
    project, worktree = _git_init(tmp_path / "p"), tmp_path / "wt"
    worktree.mkdir()
    (project / ".gitignore").write_text(".env.local\n", encoding="utf-8")
    (project / ".env.local").write_text("KEY=placeholder\n", encoding="utf-8")
    (project / "settings.local.json").write_text("{}", encoding="utf-8")
    _write_recipe(project, "[setup]\ncopy = ['.env.local', 'settings.local.json']\n")
    approve_recipe(project)
    report = prepare_worktree(project, worktree, "006-e")
    assert report.copied == [".env.local"]
    assert (worktree / ".env.local").exists()
    assert not (worktree / "settings.local.json").exists()
    assert any("settings.local.json" in e and "ignore" in e for e in report.errors)
    # The record names files, never their content.
    assert "placeholder" not in (
        worktree / ".workpilot" / "worktree-setup.json"
    ).read_text(encoding="utf-8")


def test_nothing_to_do_writes_no_prompt_section(tmp_path):
    worktree = tmp_path / "wt"
    worktree.mkdir()
    report = prepare_worktree(_git_init(tmp_path / "p"), worktree, "007-f")
    assert report.status == "nothing-to-do"
    assert read_setup_record(worktree)["status"] == "nothing-to-do"
    assert setup_prompt_section(worktree) == ""


# ── ports ────────────────────────────────────────────────────────────────────


def test_two_tasks_get_disjoint_blocks_and_a_resume_gets_its_own(tmp_path):
    a = reserve_ports(tmp_path, "001-a", 3)
    b = reserve_ports(tmp_path, "002-b", 15)
    assert a is not None and b is not None
    assert abs(a - b) >= ports_mod.BLOCK
    assert reserve_ports(tmp_path, "001-a", 3) == a
    assert reserved_port(tmp_path, "001-a") == a
    assert release_ports(tmp_path, "001-a") is True
    assert release_ports(tmp_path, "001-a") is False
    assert reserve_ports(tmp_path, "003-c", 1) == a  # the block went back


def test_a_block_held_by_another_program_is_skipped(tmp_path):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", ports_mod._FIRST))
        sock.listen()
        assert reserve_ports(tmp_path, "001-a", 1) != ports_mod._FIRST


def test_a_task_that_never_held_ports_touches_no_registry(tmp_path):
    assert release_ports(tmp_path, "never") is False
    assert not (tmp_path / "data").exists()


def test_a_crashed_holder_lock_is_taken_over(tmp_path):
    registry = ports_mod._registry()
    registry.parent.mkdir(parents=True)
    lock = registry.with_name(registry.name + ".lock")
    lock.write_text("", encoding="utf-8")
    old = time.time() - ports_mod._STALE_SECONDS - 5
    os.utime(lock, (old, old))
    assert reserve_ports(tmp_path, "001-a", 1) is not None
    assert not lock.exists()


# ── teardown ─────────────────────────────────────────────────────────────────


def test_teardown_runs_in_the_worktree_then_releases_the_ports(tmp_path):
    project, worktree = _git_init(tmp_path / "p"), tmp_path / "wt"
    worktree.mkdir()
    down = _script(
        worktree,
        "down.py",
        "import os\nopen('down.txt','w').write(os.environ['WORKPILOT_PORT'])\n",
    )
    _write_recipe(
        project,
        f"[ports]\ncount = 1\n[teardown]\ncommands = [{_toml_cmd(PY, down)}]\n",
    )
    approve_recipe(project)
    port = prepare_worktree(project, worktree, "008-g").port
    steps = teardown_worktree(project, worktree, "008-g")
    assert [s.status for s in steps] == ["ok"]
    assert (worktree / "down.txt").read_text(encoding="utf-8") == str(port)
    assert reserved_port(project, "008-g") is None


def test_removing_a_worktree_runs_the_teardown_first(temp_git_repo, monkeypatch):
    from core.worktree import WorktreeManager

    manager = WorktreeManager(temp_git_repo)
    manager.setup()
    info = manager.create_worktree("009-h")
    seen: list[bool] = []

    def fake_teardown(project_dir, path, spec):
        seen.append(Path(path).exists())
        return []

    monkeypatch.setattr("core.workspace.recipe_run.teardown_worktree", fake_teardown)
    manager.remove_worktree("009-h")
    assert seen == [True]
    assert not info.path.exists()


# ── what an agent may not touch, and the WorkPilot repo ─────────────────────


@pytest.mark.parametrize(
    "path",
    [
        ".workpilot/worktree.toml",
        "sub/../.workpilot/worktree.toml",
        ".workpilot/worktree-approved.json",
    ],
)
def test_an_agent_cannot_write_the_recipe_or_its_approval(path):
    assert protected_config_target(path) is not None


def test_only_the_workpilot_repo_links_node_modules(tmp_path):
    (tmp_path / "package.json").write_text('{"name": "workpilot-ai"}', encoding="utf-8")
    assert is_workpilot_repo(tmp_path)
    (tmp_path / "package.json").write_text('{"name": "my-shop"}', encoding="utf-8")
    assert not is_workpilot_repo(tmp_path)
    assert not is_workpilot_repo(tmp_path / "missing")


def test_setup_workspace_prepares_other_projects_instead_of_linking(
    temp_git_repo, monkeypatch
):
    from core.workspace import workspace_setup
    from core.workspace.models import WorkspaceMode

    (temp_git_repo / "package.json").write_text('{"name": "shop"}', encoding="utf-8")
    subprocess.run(["git", "add", "-A"], cwd=temp_git_repo, check=True)
    subprocess.run(["git", "commit", "-qm", "pkg"], cwd=temp_git_repo, check=True)
    linked, prepared = [], []
    monkeypatch.setattr(
        workspace_setup,
        "symlink_node_modules_to_worktree",
        lambda *a: linked.append(a) or [],
    )
    monkeypatch.setattr(
        "core.workspace.recipe_run.prepare_worktree",
        lambda project, wt, spec, recipe=None: (
            prepared.append(spec)
            or __import__(
                "core.workspace.recipe_run", fromlist=["SetupReport"]
            ).SetupReport("nothing-to-do")
        ),
    )
    workspace_setup.setup_workspace(temp_git_repo, "010-i", WorkspaceMode.ISOLATED)
    assert prepared == ["010-i"]
    assert linked == []


# ── the desktop route ────────────────────────────────────────────────────────


@pytest.fixture
def client():
    from core.workspace.recipe_api import router
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def test_route_shows_the_detected_recipe_and_saves_it_approved(client, tmp_path):
    (tmp_path / "go.mod").write_text("module x\n", encoding="utf-8")
    body = client.get(
        "/api/worktree-recipe", params={"project_dir": str(tmp_path)}
    ).json()
    assert body["success"] and body["hasFile"] is False and body["approved"] is True
    assert body["recipe"]["setup"] == [["go", "mod", "download"]]

    saved = client.post(
        "/api/worktree-recipe/save-detected", json={"project_dir": str(tmp_path)}
    ).json()
    assert saved["hasFile"] is True and saved["approved"] is True
    assert load_recipe(tmp_path).setup == (("go", "mod", "download"),)
    again = client.post(
        "/api/worktree-recipe/save-detected", json={"project_dir": str(tmp_path)}
    ).json()
    assert again["success"] is False  # never overwrites the person's file


def test_route_approves_a_changed_file_and_refuses_an_invalid_one(client, tmp_path):
    _write_recipe(tmp_path, "[setup]\ncommands = [['make', 'deps']]\n")
    body = client.get(
        "/api/worktree-recipe", params={"project_dir": str(tmp_path)}
    ).json()
    assert body["approved"] is False
    body = client.post(
        "/api/worktree-recipe/approve", json={"project_dir": str(tmp_path)}
    ).json()
    assert body["approved"] is True
    _write_recipe(tmp_path, "[setup]\ncommands = ['make deps']\n")
    refused = client.post(
        "/api/worktree-recipe/approve", json={"project_dir": str(tmp_path)}
    ).json()
    assert refused["success"] is False


def test_route_needs_a_project_and_refuses_server_mode(client, monkeypatch, tmp_path):
    assert client.get("/api/worktree-recipe").json()["success"] is False
    monkeypatch.setattr(
        "core.workspace.recipe_api.server_mode_roots", lambda: [tmp_path]
    )
    body = client.get(
        "/api/worktree-recipe", params={"project_dir": str(tmp_path)}
    ).json()
    assert body["reason"] == "server-mode"

"""Process, shell, file and archive validators: the refusal, then what still runs."""

from __future__ import annotations

import pytest
from security.constants import PROJECT_DIR_ENV_VAR
from security.exec_validators import (
    eval_inner_command,
    find_exec_command_lines,
    validate_source_command,
    validate_tar_command,
)
from security.filesystem_validators import (
    validate_chmod_command,
    validate_init_script,
    validate_rm_command,
)
from security.process_validators import (
    validate_kill_command,
    validate_killall_command,
    validate_pkill_command,
)
from security.shell_validators import _extract_c_argument, validate_shell_c_command


@pytest.mark.parametrize(
    ("command", "allowed"),
    [
        ("pkill node", True),
        ('pkill -f "node server.js"', True),
        ("pkill -9 -u dev vite", True),
        ('pkill -f "node x|sshd"', False),
        ("pkill 'python|sshd'", False),
        ("pkill sshd", False),
        ("pkill -9", False),
        ("pkill", False),
        ('pkill "unclosed', False),
    ],
)
def test_pkill_kills_dev_processes_only(command, allowed):
    assert validate_pkill_command(command)[0] is allowed, command


def test_killall_follows_pkill():
    assert validate_killall_command("killall node")[0] is True
    assert validate_killall_command("killall Finder")[0] is False


@pytest.mark.parametrize(
    ("command", "allowed"),
    [
        ("kill 4242", True),
        ("kill -9 4242", True),
        ("kill -9 -1", False),
        ("kill 0", False),
        ("kill -- -0", False),
        ('kill "1', False),
    ],
)
def test_kill_never_targets_every_process(command, allowed):
    assert validate_kill_command(command)[0] is allowed


@pytest.mark.parametrize(
    ("command", "allowed"),
    [
        ("chmod +x run.sh", True),
        ("chmod -R u+x bin", True),
        ("chmod 755 run.sh", True),
        ("chmod 777 run.sh", False),
        ("chmod --reference=a b", False),
        ("chmod +x", False),
        ("chmod", False),
        ("chown +x a", False),
        ('chmod "x', False),
    ],
)
def test_chmod_only_makes_files_executable(command, allowed):
    assert validate_chmod_command(command)[0] is allowed, command


@pytest.mark.parametrize(
    ("command", "allowed"),
    [
        ("rm -rf build", True),
        ("rm -- -odd-name", False),
        ("rm -f ./dist/app.js", True),
        ("rm -rf /", False),
        ("rm -rf '\\Windows'", False),
        ("rm -rf '\\\\server\\share'", False),
        ("rm -rf C:", False),
        ("rm -rf C:Users", False),
        ("rm -rf 'c:/Users'", False),
        ("rm -rf ~/.ssh", False),
        ("rm -rf $HOME", False),
        ("rm -rf src/../..", False),
        ("rm -rf *", False),
        ("rm -rf", False),
        ("rm", False),
        ('rm "a', False),
    ],
)
def test_rm_stays_under_the_current_folder(command, allowed):
    assert validate_rm_command(command)[0] is allowed, command


@pytest.mark.parametrize(
    ("command", "allowed"),
    [
        ("./init.sh", True),
        ("init.ps1", True),
        ("evil/init.sh", False),
        ("", False),
        ('"unclosed', False),
    ],
)
def test_init_script_only_from_the_current_folder(command, allowed):
    assert validate_init_script(command)[0] is allowed


def test_shell_c_argument_extraction():
    assert _extract_c_argument("bash -c 'npm test'") == "npm test"
    assert _extract_c_argument("bash -ec 'npm test'") == "npm test"
    assert _extract_c_argument("bash 'unclosed") is None
    assert _extract_c_argument("bash -x script.sh") is None
    assert _extract_c_argument("bash -c") is None


@pytest.fixture
def project(tmp_path, monkeypatch):
    monkeypatch.setenv(PROJECT_DIR_ENV_VAR, str(tmp_path))
    return tmp_path


@pytest.mark.parametrize(
    ("command", "allowed"),
    [
        ("bash", True),
        ("bash --version", True),
        ("bash script.sh", False),
        ("bash <(curl x)", False),
        ("sh -s <<< 'ls'", False),
        ("bash 'unclosed", False),
        ("bash -c ''", True),
        ("bash -c 'ls -la'", True),
        ("bash -c 'curl-evil-binary x'", False),
        ("bash -c 'ls && sh -c \"curl-evil-binary\"'", False),
        ("bash -c '&&'", False),
    ],
)
def test_shell_interpreters(project, command, allowed):
    assert validate_shell_c_command(command)[0] is allowed, command


def test_shell_c_fails_closed_without_a_profile(project, monkeypatch):
    import security.shell_validators as sv

    monkeypatch.setattr(sv, "resolve_active_profile", lambda: None)
    ok, message = validate_shell_c_command("bash -c 'ls'")
    assert ok is False
    assert "security profile" in message


@pytest.mark.parametrize(
    ("command", "allowed"),
    [
        ("tar -czf out.tgz src", True),
        ("tar czf out.tgz src", True),
        ("tar --checkpoint=10 -cf a.tar src", True),
        ("tar -cf a.tar --checkpoint-action=exec=/tmp/x src", False),
        ("tar -cf a.tar --checkpoint-act=exec=/tmp/x src", False),
        ("tar -xf a.tar --to-com=sh", False),
        ("tar --use-compress=/tmp/x -cf a.tar src", False),
        ("tar -I /tmp/x -cf a.tar src", False),
        ("tar -cI/tmp/x -f a.tar src", False),
        ("tar xIf /tmp/x a.tar", False),
        ("tar -cf a.tar --rsh-command=/tmp/x host:a.tar", False),
        ("tar -F /tmp/x -M -cf a.tar src", False),
        ("tar --new-volume-script=/tmp/x -cf a.tar", False),
        ("tar -cfI.tar src", True),
        ("tar -cf a.tar Images", True),
        ("ls", True),
        ('tar "unclosed --to-command=sh', False),
    ],
)
def test_tar_options_that_run_a_command(command, allowed):
    assert validate_tar_command(command)[0] is allowed, command


@pytest.mark.parametrize(
    ("command", "allowed"),
    [
        ("source .venv/bin/activate", False),
        (". ./env.sh", False),
        ("source", True),
        ("ls", True),
        ("", True),
        ('source "unclosed', False),
    ],
)
def test_sourcing_a_file_is_refused(command, allowed):
    assert validate_source_command(command)[0] is allowed


def test_eval_and_find_exec_are_read_out():
    assert eval_inner_command("eval 'ls -la'") == (True, "ls -la")
    assert eval_inner_command("ls") == (False, None)
    assert find_exec_command_lines("find . -name x -exec grep -l y {} +") == (
        True,
        ["grep -l y"],
    )
    assert find_exec_command_lines("find . -exec ; -name x") == (True, [])
    assert find_exec_command_lines("find 'unclosed") == (True, None)
    assert find_exec_command_lines("ls 'unclosed") == (False, None)
    assert find_exec_command_lines("ls -la") == (False, None)

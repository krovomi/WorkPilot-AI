"""Credential discovery for the Windsurf language server (`windsurf_proxy/auth.py`).

The process listings, socket listings and the IDE's SQLite state database are
real inputs here: the listings are the text `ps`/`lsof`/`netstat`/PowerShell
print (fed through a stand-in for `subprocess.check_output`, so every OS walks
every branch), the database is a real `state.vscdb` written in `tmp_path`.
"""

from __future__ import annotations

import json
import sqlite3
import subprocess
from pathlib import Path

import pytest
from integrations.windsurf_proxy import auth

CSRF = "0a1b2c3d-4e5f-6789-abcd-ef0123456789"

PS_LINE = (
    "leub      4242  1.0  2.0 1000 2000 ?  Sl 10:00 0:01 "
    "/opt/windsurf/language_server_linux --csrf_token "
    f"{CSRF} --extension_server_port 42100 --windsurf_version 1.13.200+abc"
)


@pytest.fixture(autouse=True)
def _clean_discovery(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    """Each test starts with no cache, no env key, no IDE files."""
    auth.invalidate_process_cache()
    for name in ("WINDSURF_API_KEY", "WINDSURF_OAUTH_TOKEN", "CODEIUM_API_KEY"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(auth, "_SYSTEM", "Linux")
    monkeypatch.setattr(auth, "_VSCDB_PATHS", {"Linux": tmp_path / "absent.vscdb"})
    monkeypatch.setattr(auth, "_LEGACY_CONFIG_PATH", tmp_path / "absent.json")
    yield
    auth.invalidate_process_cache()


def _state_db(path: Path, rows: dict[str, str]) -> Path:
    conn = sqlite3.connect(str(path))
    conn.execute("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)")
    conn.executemany("INSERT INTO ItemTable VALUES (?, ?)", list(rows.items()))
    conn.commit()
    conn.close()
    return path


def _use_db(monkeypatch: pytest.MonkeyPatch, path: Path) -> None:
    monkeypatch.setattr(auth, "_VSCDB_PATHS", {auth._SYSTEM: path})


def _fake_check_output(outputs: dict[str, object], calls: list[list[str]]):
    """`check_output` answering by program name; an exception value is raised."""

    def fake(argv, **_kwargs):
        calls.append(list(argv))
        answer = outputs.get(argv[0], "")
        if isinstance(answer, BaseException):
            raise answer
        if callable(answer):
            return answer(argv)
        return answer

    return fake


def _no_psutil_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(auth, "_get_csrf_token_from_process_env", lambda: None)


# --------------------------------------------------------------------------
# Process discovery
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("system", "pattern"),
    [
        ("Darwin", "language_server_macos"),
        ("Linux", "language_server_linux"),
        ("Windows", "language_server_windows"),
        ("Plan9", "language_server"),
    ],
)
def test_language_server_pattern_follows_the_os(monkeypatch, system, pattern):
    monkeypatch.setattr(auth, "_SYSTEM", system)
    assert auth._get_language_server_pattern() == pattern


def test_ps_listing_keeps_only_language_server_lines(monkeypatch):
    calls: list[list[str]] = []
    listing = "\n".join(
        [
            "USER PID %CPU",
            PS_LINE,
            "leub 1 0 0 grep language_server_linux",
            "leub 7 0 0 /usr/bin/bash",
        ]
    )
    monkeypatch.setattr(
        auth.subprocess, "check_output", _fake_check_output({"ps": listing}, calls)
    )
    assert auth._discover_language_server_process() == PS_LINE
    assert calls == [["ps", "aux"]]


def test_ps_listing_without_the_server_is_none(monkeypatch):
    monkeypatch.setattr(
        auth.subprocess,
        "check_output",
        _fake_check_output({"ps": "leub 7 0 0 /usr/bin/bash"}, []),
    )
    assert auth._discover_language_server_process() is None


@pytest.mark.parametrize(
    "error",
    [
        subprocess.TimeoutExpired(["ps"], 5),
        subprocess.CalledProcessError(1, ["ps"]),
        FileNotFoundError("ps"),
        UnicodeDecodeError("utf-8", b"\xff", 0, 1, "bad"),
    ],
)
def test_ps_failure_means_not_found(monkeypatch, error):
    monkeypatch.setattr(
        auth.subprocess, "check_output", _fake_check_output({"ps": error}, [])
    )
    assert auth._discover_language_server_process() is None


def test_windows_prefers_powershell(monkeypatch):
    monkeypatch.setattr(auth, "_SYSTEM", "Windows")
    calls: list[list[str]] = []
    answer = (
        "ProcessId=99\nCommandLine=language_server_windows.exe --csrf_token ab12cd34"
    )
    monkeypatch.setattr(
        auth.subprocess,
        "check_output",
        _fake_check_output({"powershell": answer, "wmic": "unused"}, calls),
    )
    assert auth._discover_language_server_process() == answer
    assert [c[0] for c in calls] == ["powershell"]
    assert "language_server_windows" in calls[0][-1]


def test_windows_falls_back_to_wmic_then_its_second_query(monkeypatch):
    monkeypatch.setattr(auth, "_SYSTEM", "Windows")
    calls: list[list[str]] = []

    def wmic(argv):
        # First query (by name) finds nothing; the one by command line does.
        return "  \n" if "get" in argv and argv[-2] == "CommandLine" else "Found=1"

    monkeypatch.setattr(
        auth.subprocess,
        "check_output",
        _fake_check_output({"powershell": "   ", "wmic": wmic}, calls),
    )
    assert auth._discover_language_server_process() == "Found=1"
    assert [c[0] for c in calls] == ["powershell", "wmic", "wmic"]
    assert calls[2][3] == "commandline like '%language_server_windows%'"


def test_windows_with_nothing_found_is_none(monkeypatch):
    monkeypatch.setattr(auth, "_SYSTEM", "Windows")
    monkeypatch.setattr(
        auth.subprocess,
        "check_output",
        _fake_check_output(
            {
                "powershell": FileNotFoundError("powershell"),
                "wmic": subprocess.CalledProcessError(1, ["wmic"]),
            },
            [],
        ),
    )
    assert auth._discover_language_server_process() is None


def test_wmic_empty_on_both_queries_is_none(monkeypatch):
    monkeypatch.setattr(
        auth.subprocess, "check_output", _fake_check_output({"wmic": " "}, [])
    )
    assert auth._discover_via_wmic("language_server_windows") is None


def test_process_listing_is_cached_until_invalidated(monkeypatch):
    seen: list[int] = []

    def discover():
        seen.append(1)
        return f"listing {len(seen)}"

    monkeypatch.setattr(auth, "_discover_language_server_process", discover)
    assert auth._get_language_server_process() == "listing 1"
    assert auth._get_language_server_process() == "listing 1"
    auth.invalidate_process_cache()
    assert auth._get_language_server_process() == "listing 2"


def test_process_cache_expires_after_its_ttl(monkeypatch):
    seen: list[int] = []

    def discover():
        seen.append(1)
        return f"listing {len(seen)}"

    monkeypatch.setattr(auth, "_discover_language_server_process", discover)
    monkeypatch.setattr(auth, "_PROCESS_CACHE_TTL", 0.0)
    auth._get_language_server_process()
    assert auth._get_language_server_process() == "listing 2"


# --------------------------------------------------------------------------
# CSRF token
# --------------------------------------------------------------------------


def test_csrf_from_the_command_line_wins(monkeypatch):
    monkeypatch.setattr(auth, "_get_language_server_process", lambda: PS_LINE)
    monkeypatch.setattr(
        auth,
        "_get_csrf_token_from_process_env",
        lambda: pytest.fail("the CLI argument is enough"),
    )
    assert auth.get_csrf_token() == CSRF


def test_csrf_from_process_env_when_the_cli_has_none(monkeypatch):
    monkeypatch.setattr(
        auth, "_get_language_server_process", lambda: "language_server_linux"
    )
    monkeypatch.setattr(auth, "_get_csrf_token_from_process_env", lambda: "feedc0de")
    assert auth.get_csrf_token() == "feedc0de"


def test_csrf_from_state_db_as_last_resort(monkeypatch, tmp_path):
    _use_db(
        monkeypatch,
        _state_db(
            tmp_path / "state.vscdb", {"codeium.windsurf-windsurf_auth-": f" {CSRF} "}
        ),
    )
    monkeypatch.setattr(auth, "_get_language_server_process", lambda: None)
    _no_psutil_env(monkeypatch)
    assert auth.get_csrf_token() == CSRF


def test_csrf_missing_without_a_process_says_not_running(monkeypatch):
    monkeypatch.setattr(auth, "_get_language_server_process", lambda: None)
    _no_psutil_env(monkeypatch)
    with pytest.raises(auth.WindsurfError) as caught:
        auth.get_csrf_token()
    assert caught.value.code is auth.WindsurfErrorCode.NOT_RUNNING


def test_csrf_missing_with_a_process_says_csrf_missing(monkeypatch):
    monkeypatch.setattr(
        auth, "_get_language_server_process", lambda: "language_server_linux"
    )
    _no_psutil_env(monkeypatch)
    with pytest.raises(auth.WindsurfError) as caught:
        auth.get_csrf_token()
    assert caught.value.code is auth.WindsurfErrorCode.CSRF_MISSING


def test_state_db_csrf_must_look_like_a_token(monkeypatch, tmp_path):
    _use_db(
        monkeypatch,
        _state_db(
            tmp_path / "state.vscdb",
            {"codeium.windsurf-windsurf_auth-": "not a token!"},
        ),
    )
    assert auth._get_csrf_token_from_state_db() is None


def test_state_db_without_the_table_is_none(monkeypatch, tmp_path):
    db = tmp_path / "state.vscdb"
    sqlite3.connect(str(db)).close()
    _use_db(monkeypatch, db)
    assert auth._get_csrf_token_from_state_db() is None


def test_state_db_unknown_os_is_none(monkeypatch):
    monkeypatch.setattr(auth, "_SYSTEM", "Plan9")
    assert auth._get_csrf_token_from_state_db() is None
    assert auth._get_api_key_from_state_db() is None


class _Proc:
    def __init__(self, pid, name, cmdline, env=None, error=None):
        self.pid = pid
        self.info = {"pid": pid, "name": name, "cmdline": cmdline}
        self._env = env or {}
        self._error = error

    def environ(self):
        if self._error is not None:
            raise self._error
        return self._env


def test_csrf_from_the_windsurf_process_environment(monkeypatch):
    psutil = pytest.importorskip("psutil")
    procs = [
        _Proc(1, "bash", ["/bin/bash"]),
        # The pattern matches but it is not Windsurf's server.
        _Proc(2, "language_server_linux", ["/opt/other/language_server_linux"]),
        _Proc(
            3,
            "language_server_linux",
            ["/opt/windsurf/x"],
            error=psutil.AccessDenied(3),
        ),
        _Proc(
            4, "language_server_linux", ["/opt/windsurf/x"], error=RuntimeError("odd")
        ),
        _Proc(
            5,
            "language_server_linux",
            ["/opt/windsurf/x"],
            env={"WINDSURF_CSRF_TOKEN": "nope!"},
        ),
        _Proc(
            6,
            None,
            ["/opt/codeium/language_server_linux"],
            env={"WINDSURF_CSRF_TOKEN": "c0ffee00"},
        ),
    ]
    monkeypatch.setattr(psutil, "process_iter", lambda _attrs: iter(procs))
    assert auth._get_csrf_token_from_process_env() == "c0ffee00"


def test_process_environment_without_a_token_is_none(monkeypatch):
    psutil = pytest.importorskip("psutil")
    monkeypatch.setattr(psutil, "process_iter", lambda _attrs: iter([]))
    assert auth._get_csrf_token_from_process_env() is None


def test_process_environment_without_psutil_is_none(monkeypatch):
    import builtins

    real_import = builtins.__import__

    def no_psutil(name, *args, **kwargs):
        if name == "psutil":
            raise ImportError("no psutil")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", no_psutil)
    assert auth._get_csrf_token_from_process_env() is None


# --------------------------------------------------------------------------
# Port
# --------------------------------------------------------------------------


def test_pid_from_a_ps_line_and_from_a_windows_listing(monkeypatch):
    assert auth._extract_pid_from_process_info(PS_LINE) == "4242"
    assert auth._extract_pid_from_process_info("") is None
    monkeypatch.setattr(auth, "_SYSTEM", "Windows")
    assert auth._extract_pid_from_process_info("ProcessId=77\nCommandLine=x") == "77"
    assert auth._extract_pid_from_process_info("CommandLine=x") is None


def test_extension_port_from_the_command_line():
    assert auth._extract_extension_port(PS_LINE) == 42100
    assert auth._extract_extension_port("no port here") is None


def test_listening_ports_from_lsof(monkeypatch):
    calls: list[list[str]] = []
    lsof = (
        "language 4242 leub 10u IPv4 TCP 127.0.0.1:42101 (LISTEN)\n"
        "language 4242 leub 11u IPv4 TCP 127.0.0.1:42103 (LISTEN)\n"
        "language 4242 leub 12u IPv4 TCP 127.0.0.1:5000->1.2.3.4:443 (ESTABLISHED)\n"
    )
    monkeypatch.setattr(
        auth.subprocess, "check_output", _fake_check_output({"lsof": lsof}, calls)
    )
    assert auth._get_listening_ports("4242") == [42101, 42103]
    assert calls == [["lsof", "-p", "4242", "-i", "-P", "-n"]]


def test_listening_ports_from_netstat_keep_only_that_pid(monkeypatch):
    monkeypatch.setattr(auth, "_SYSTEM", "Windows")
    netstat = (
        "  TCP    127.0.0.1:42101    0.0.0.0:0    LISTENING    77\n"
        "  TCP    127.0.0.1:9999     0.0.0.0:0    LISTENING    12\n"
    )
    monkeypatch.setattr(
        auth.subprocess, "check_output", _fake_check_output({"netstat": netstat}, [])
    )
    assert auth._get_listening_ports("77") == [42101]


def test_listening_ports_need_a_pid_and_a_working_tool(monkeypatch):
    assert auth._get_listening_ports("") == []
    monkeypatch.setattr(
        auth.subprocess,
        "check_output",
        _fake_check_output({"lsof": FileNotFoundError("lsof")}, []),
    )
    assert auth._get_listening_ports("4242") == []


def test_best_port_is_the_first_above_the_extension_port():
    assert auth._select_best_port([], 42100) is None
    assert auth._select_best_port([42105, 42099, 42101], 42100) == 42101
    assert auth._select_best_port([42099, 5], 42100) == 42099
    assert auth._select_best_port([8080, 9090], None) == 8080


def test_port_found_by_socket_listing(monkeypatch):
    monkeypatch.setattr(auth, "_get_language_server_process", lambda: PS_LINE)
    monkeypatch.setattr(auth, "_get_listening_ports", lambda pid: [42099, 42103])
    assert auth.get_port() == 42103


def test_port_falls_back_to_extension_port_plus_three(monkeypatch):
    monkeypatch.setattr(auth, "_get_language_server_process", lambda: PS_LINE)
    monkeypatch.setattr(auth, "_get_listening_ports", lambda pid: [])
    assert auth.get_port() == 42103


def test_port_without_a_process_or_a_hint_is_an_error(monkeypatch):
    monkeypatch.setattr(auth, "_get_language_server_process", lambda: None)
    with pytest.raises(auth.WindsurfError, match="not found"):
        auth.get_port()
    monkeypatch.setattr(
        auth, "_get_language_server_process", lambda: "language_server_linux"
    )
    with pytest.raises(auth.WindsurfError, match="port not found") as caught:
        auth.get_port()
    assert caught.value.code is auth.WindsurfErrorCode.NOT_RUNNING


# --------------------------------------------------------------------------
# API key
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "var", ["WINDSURF_API_KEY", "WINDSURF_OAUTH_TOKEN", "CODEIUM_API_KEY"]
)
def test_api_key_from_the_environment_first(monkeypatch, var):
    monkeypatch.setenv(var, "sk-test-0000")
    assert auth.get_api_key() == "sk-test-0000"


@pytest.mark.parametrize(
    ("status", "expected"),
    [
        ({"apiKey": "sk-ws-test-0000"}, "sk-ws-test-0000"),
        ({"accessToken": "eyJ-test-access"}, "eyJ-test-access"),
        ({"token": "eyJ-test-token"}, "eyJ-test-token"),
    ],
)
def test_api_key_from_windsurf_auth_status(monkeypatch, tmp_path, status, expected):
    _use_db(
        monkeypatch,
        _state_db(tmp_path / "s.vscdb", {"windsurfAuthStatus": json.dumps(status)}),
    )
    assert auth.get_api_key() == expected


@pytest.mark.parametrize(
    ("key", "value", "expected"),
    [
        ("windsurf.authToken", json.dumps({"apiKey": "sk-test-json"}), "sk-test-json"),
        ("codeium.apiKey", "  sk-test-raw  ", "sk-test-raw"),
        ("service-auth/windsurf", "eyJ-test-jwt", "eyJ-test-jwt"),
    ],
)
def test_api_key_from_alternative_entries(monkeypatch, tmp_path, key, value, expected):
    rows = {"windsurfAuthStatus": json.dumps({"other": 1}), key: value}
    _use_db(monkeypatch, _state_db(tmp_path / "s.vscdb", rows))
    assert auth.get_api_key() == expected


def test_unusable_database_entries_fall_through_to_the_legacy_config(
    monkeypatch, tmp_path
):
    rows = {
        "windsurfAuthStatus": "{broken json",
        "windsurf.authToken": json.dumps(["not", "a", "dict"]),
        "codeium.apiKey": "plain words",
    }
    _use_db(monkeypatch, _state_db(tmp_path / "s.vscdb", rows))
    legacy = tmp_path / "config.json"
    legacy.write_text(json.dumps({"api_key": "sk-test-legacy"}), encoding="utf-8")
    monkeypatch.setattr(auth, "_LEGACY_CONFIG_PATH", legacy)
    assert auth.get_api_key() == "sk-test-legacy"


def test_alternative_keys_on_a_database_without_the_table(tmp_path):
    db = tmp_path / "empty.vscdb"
    sqlite3.connect(str(db)).close()
    assert auth._get_api_key_from_alternative_db_keys(db) is None
    assert auth._get_api_key_from_main_db(db) is None


@pytest.mark.parametrize("content", ["{nope", json.dumps({"other": "x"})])
def test_legacy_config_unreadable_or_keyless(monkeypatch, tmp_path, content):
    legacy = tmp_path / "config.json"
    legacy.write_text(content, encoding="utf-8")
    monkeypatch.setattr(auth, "_LEGACY_CONFIG_PATH", legacy)
    assert auth._get_api_key_from_legacy_config() is None


def test_no_key_anywhere_asks_to_log_in():
    with pytest.raises(auth.WindsurfError, match="login to Windsurf") as caught:
        auth.get_api_key()
    assert caught.value.code is auth.WindsurfErrorCode.API_KEY_MISSING


# --------------------------------------------------------------------------
# Version, the whole discovery, liveness
# --------------------------------------------------------------------------


def test_version_drops_the_build_suffix(monkeypatch):
    monkeypatch.setattr(auth, "_get_language_server_process", lambda: PS_LINE)
    assert auth.get_windsurf_version() == "1.13.200"


def test_version_defaults_when_unknown(monkeypatch):
    monkeypatch.setattr(auth, "_get_language_server_process", lambda: None)
    assert auth.get_windsurf_version() == "1.13.104"
    monkeypatch.setattr(
        auth, "_get_language_server_process", lambda: "language_server_linux"
    )
    assert auth.get_windsurf_version() == "1.13.104"


def test_discover_credentials_from_one_listing(monkeypatch, caplog):
    monkeypatch.setattr(auth, "_discover_language_server_process", lambda: PS_LINE)
    monkeypatch.setattr(auth, "_get_listening_ports", lambda pid: [42102])
    monkeypatch.setenv("WINDSURF_API_KEY", "sk-test-0000")
    caplog.set_level("INFO", logger=auth.logger.name)

    creds = auth.discover_credentials()

    assert creds == auth.WindsurfCredentials(
        csrf_token=CSRF, port=42102, api_key="sk-test-0000", version="1.13.200"
    )
    # Presence only: neither secret reaches the log.
    assert "sk-test-0000" not in caplog.text
    assert CSRF not in caplog.text
    assert "csrf_present=True" in caplog.text


def test_running_when_csrf_and_port_are_found(monkeypatch):
    monkeypatch.setattr(auth, "_get_language_server_process", lambda: PS_LINE)
    monkeypatch.setattr(auth, "_get_listening_ports", lambda pid: [])
    assert auth.is_windsurf_running() is True


def test_running_by_process_and_stored_csrf_when_discovery_fails(monkeypatch, tmp_path):
    _use_db(
        monkeypatch,
        _state_db(tmp_path / "s.vscdb", {"codeium.windsurf-windsurf_auth-": CSRF}),
    )
    monkeypatch.setattr(
        auth, "_get_language_server_process", lambda: "language_server_linux"
    )
    _no_psutil_env(monkeypatch)
    # The CSRF comes from the database but no port can be found.
    assert auth.is_windsurf_running() is True


def test_not_running_without_a_process(monkeypatch):
    monkeypatch.setattr(auth, "_get_language_server_process", lambda: None)
    _no_psutil_env(monkeypatch)
    assert auth.is_windsurf_running() is False


def test_not_running_when_the_fallback_check_itself_fails(monkeypatch):
    def broken():
        raise RuntimeError("listing exploded")

    monkeypatch.setattr(auth, "_get_language_server_process", broken)
    assert auth.is_windsurf_running() is False


def test_error_keeps_its_code_and_details():
    err = auth.WindsurfError(
        "boom", auth.WindsurfErrorCode.AUTH_FAILED, details={"x": 1}
    )
    assert str(err) == "boom"
    assert err.code is auth.WindsurfErrorCode.AUTH_FAILED
    assert err.details == {"x": 1}

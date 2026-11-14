"""The Regression Guardian runner, run as the dashboard and the automation run it.

The scan and the inbox feed are the real process on real files. Sentry is
reached through its HTTP client with only the transport replaced, so the
headers, redirects, status, size and JSON checks are the runner's own.
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path

import httpx
import pytest
from regression_guardian.feed import INBOX, FeedError

BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
RUNNER = BACKEND / "runners" / "regression_guardian_runner.py"
INCIDENTS = Path(".workpilot") / "incidents"
SINCE = "2023-11-14T22:13:20Z"
SINCE_TS = 1_700_000_000.0

SENTRY_PAYLOAD = {
    "event": {
        "event_id": "abc123",
        "title": "KeyError: 'sku'",
        "level": "error",
        "environment": "production",
        "exception": {
            "values": [
                {
                    "type": "KeyError",
                    "value": "'sku'",
                    "stacktrace": {
                        "frames": [
                            {
                                "filename": "shop/cart.py",
                                "function": "add_item",
                                "lineno": 42,
                            }
                        ]
                    },
                }
            ]
        },
    }
}


def _run(project: Path, *args: str, stdin: str = "", env: dict | None = None):
    done = subprocess.run(
        [sys.executable, str(RUNNER), "--project-path", str(project), *args],
        cwd=BACKEND,
        input=stdin,
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=120,
        check=False,
    )
    events, last = [], None
    for line in done.stdout.splitlines():
        prefix, _, payload = line.partition(":")
        if prefix == "REGRESSION_GUARDIAN_EVENT":
            events.append(json.loads(payload))
        elif prefix.startswith("REGRESSION_GUARDIAN_"):
            last = (prefix, json.loads(payload))
    return done.returncode, events, last


def _incident(project: Path, name: str, payload: object) -> None:
    folder = project / INCIDENTS
    folder.mkdir(parents=True, exist_ok=True)
    text = payload if isinstance(payload, str) else json.dumps(payload)
    (folder / name).write_text(text, encoding="utf-8")


# --- the dashboard's scan ------------------------------------------------------------


def test_a_project_without_incidents(tmp_path: Path) -> None:
    code, events, (kind, result) = _run(tmp_path)

    assert (code, kind, result) == (0, "REGRESSION_GUARDIAN_RESULT", {"results": []})
    assert events[-1]["data"] == {"status": "No incidents found", "results": 0}


def test_incidents_become_regression_tests(tmp_path: Path) -> None:
    (tmp_path / "pyproject.toml").write_text(
        "[project]\nname='shop'\n", encoding="utf-8"
    )
    _incident(tmp_path, "a-cart.json", SENTRY_PAYLOAD)
    _incident(tmp_path, "c-broken.json", "{not json")
    _incident(tmp_path, "d-list.json", [1, 2])
    (tmp_path / INCIDENTS / "e-folder.json").mkdir()

    code, events, (_kind, result) = _run(tmp_path)

    assert code == 0
    [first] = result["results"]
    incident = first["incident"]
    assert incident["source"] == "sentry"
    assert incident["exceptionType"] == "KeyError"
    assert incident["faultingFile"] == "shop/cart.py"
    assert incident["stackFrames"][0]["line"] == 42
    assert first["generatedTest"]["framework"] == "pytest"
    assert first["generatedTest"]["code"]
    assert first["isDuplicate"] is False and first["fixtureData"]
    statuses = [e["data"].get("status", "") for e in events]
    assert any(s.startswith("Skipped c-broken.json") for s in statuses)
    # A payload the parser refuses is said, not dropped in silence.
    assert any(s.startswith("Skipped d-list.json: Parse error") for s in statuses)
    assert "Processing 3 incident(s)..." in statuses
    assert events[-1]["data"] == {"results": 1}


COVERING_TEST = "def test_add_item_unknown_sku():\n    with raises(KeyError):\n        cart.add_item('x')\n"


def test_an_incident_the_project_already_tests_is_a_duplicate(tmp_path: Path) -> None:
    (tmp_path / "tests").mkdir()
    (tmp_path / "tests" / "test_cart.py").write_text(COVERING_TEST, encoding="utf-8")
    _incident(tmp_path, "a-cart.json", SENTRY_PAYLOAD)

    _code, _events, (_kind, result) = _run(tmp_path)

    # It never was: the scan gave the checker no folder to look in.
    [duplicate] = result["results"]
    assert duplicate["isDuplicate"] is True
    assert duplicate["duplicatePath"] == str(tmp_path / "tests" / "test_cart.py")
    assert duplicate["generatedTest"] is None


def test_tests_of_dependencies_and_hidden_folders_do_not_count(tmp_path: Path) -> None:
    for folder in ("node_modules/cartlib", ".venv/lib", "build"):
        (tmp_path / folder).mkdir(parents=True)
        (tmp_path / folder / "test_cart.py").write_text(COVERING_TEST, encoding="utf-8")
    _incident(tmp_path, "a-cart.json", SENTRY_PAYLOAD)

    _code, _events, (_kind, result) = _run(tmp_path)

    assert result["results"][0]["isDuplicate"] is False


def test_a_missing_project_is_an_error(tmp_path: Path) -> None:
    code, _events, (kind, message) = _run(tmp_path / "gone")

    assert (code, kind) == (1, "REGRESSION_GUARDIAN_ERROR")
    assert message.startswith("Project path does not exist")


def test_a_scan_that_fails_still_answers(tmp_path, monkeypatch, capsys) -> None:
    monkeypatch.syspath_prepend(str(BACKEND))
    from runners import regression_guardian_runner as runner

    def fail(_project):
        raise RuntimeError("index unreadable")

    monkeypatch.setattr(runner, "run_scan", fail)
    monkeypatch.setattr(sys, "argv", ["r", "--project-path", str(tmp_path)])

    with pytest.raises(SystemExit) as stop:
        runner.main()

    assert stop.value.code == 1
    assert capsys.readouterr().out.strip() == (
        'REGRESSION_GUARDIAN_ERROR:"index unreadable"'
    )


# --- the automation's feed -------------------------------------------------------------


def _inbox(project: Path) -> None:
    inbox = project / INBOX
    inbox.mkdir(parents=True, exist_ok=True)
    path = inbox / "sentry.json"
    path.write_text(json.dumps(SENTRY_PAYLOAD), encoding="utf-8")
    os.utime(path, (SINCE_TS + 60, SINCE_TS + 60))


def _feed(project: Path, request: object, **env_changes: str):
    env = {k: v for k, v in os.environ.items() if k != "SENTRY_AUTH_TOKEN"}
    env.update(env_changes)
    return _run(project, "--feed", "--since", SINCE, stdin=json.dumps(request), env=env)


def test_the_feed_reads_the_inbox(tmp_path: Path) -> None:
    _inbox(tmp_path)

    code, _events, (kind, feed) = _feed(
        tmp_path, {"trigger": {"type": "prod_incident"}, "seen": [7, "other"]}
    )

    assert (code, kind) == (0, "REGRESSION_GUARDIAN_FEED")
    [event] = feed["events"]
    assert event["key"] == "incident:sentry:abc123"
    assert "url" not in event


def test_the_feed_skips_what_the_rule_has_seen(tmp_path: Path) -> None:
    _inbox(tmp_path)

    _code, _events, (_kind, feed) = _feed(
        tmp_path,
        {"trigger": {"type": "prod_incident"}, "seen": ["incident:sentry:abc123"]},
    )

    assert feed["events"] == []


@pytest.mark.parametrize(
    ("request_", "reason", "message"),
    [
        ({"seen": []}, "source_failed", "needs a trigger and the seen keys"),
        ([1], "source_failed", "needs a trigger and the seen keys"),
        (
            {"trigger": {"org": "../x", "project": "api"}, "seen": []},
            "source_failed",
            "The Sentry organisation is not a slug",
        ),
        (
            {"trigger": {"org": "acme", "project": "api"}, "seen": []},
            "sentry_token_missing",
            "SENTRY_AUTH_TOKEN is not set",
        ),
    ],
)
def test_a_feed_that_cannot_run_says_why(
    tmp_path: Path, request_, reason: str, message: str
) -> None:
    code, _events, (kind, error) = _feed(tmp_path, request_)

    assert (code, kind) == (1, "REGRESSION_GUARDIAN_FEED_ERROR")
    assert error["reason"] == reason
    assert message in error["message"]


def test_a_strict_offline_project_never_calls_sentry(tmp_path: Path) -> None:
    policy = tmp_path / ".workpilot" / "offline-mode.json"
    policy.parent.mkdir()
    policy.write_text(
        json.dumps({"airgapStrict": True, "defaultProvider": "ollama", "routing": {}}),
        encoding="utf-8",
    )

    code, _events, (_kind, error) = _feed(
        tmp_path,
        {"trigger": {"org": "acme", "project": "api"}, "seen": []},
        SENTRY_AUTH_TOKEN="sntrys-test-0000",  # pragma: allowlist secret
    )

    assert code == 1
    assert error["reason"] == "source_failed"


# --- Sentry, through the runner's own HTTP client ---------------------------------------

ISSUE = {
    "id": "4242",
    "title": "TypeError: price is None",
    "level": "error",
    "permalink": "https://acme.sentry.io/issues/4242/",
}
LATEST = {
    "entries": [
        {
            "type": "exception",
            "data": {
                "values": [
                    {
                        "type": "TypeError",
                        "value": "price is None",
                        "stacktrace": {
                            "frames": [
                                {"filename": "src/pricing.ts", "function": "total"}
                            ]
                        },
                    }
                ]
            },
        }
    ]
}


@pytest.fixture
def runner(monkeypatch):
    monkeypatch.syspath_prepend(str(BACKEND))
    from runners import regression_guardian_runner

    return regression_guardian_runner


@pytest.fixture
def sentry(monkeypatch):
    """Replace only the transport under httpx; record what was sent."""
    sent: list[httpx.Request] = []
    state: dict = {"handler": None}
    real = httpx.AsyncClient

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(request)
        return state["handler"](request)

    def client(**kwargs):
        return real(transport=httpx.MockTransport(handler), **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", client)
    monkeypatch.setenv(
        "SENTRY_AUTH_TOKEN", "sntrys-test-0000"
    )  # pragma: allowlist secret
    state["sent"] = sent
    return state


def _sentry_feed(runner, project: Path) -> dict:
    return asyncio.run(
        runner.run_feed(project, SINCE, {"org": "acme", "project": "shop-api"}, set())
    )


def test_sentry_issues_become_events(runner, sentry, tmp_path: Path) -> None:
    def answer(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/issues/"):
            return httpx.Response(200, json=[ISSUE])
        return httpx.Response(200, json=LATEST)

    sentry["handler"] = answer

    feed = _sentry_feed(runner, tmp_path)

    [event] = feed["events"]
    assert event["key"] == "incident:sentry:4242"
    assert event["url"] == "https://acme.sentry.io/issues/4242/"
    first = sentry["sent"][0]
    assert str(first.url).startswith(
        "https://sentry.io/api/0/projects/acme/shop-api/issues/"
    )
    assert (
        first.headers["Authorization"] == "Bearer sntrys-test-0000"
    )  # pragma: allowlist secret


@pytest.mark.parametrize(
    ("response", "message"),
    [
        (
            httpx.Response(302, headers={"Location": "https://evil.test/"}),
            "answered 302",
        ),
        (httpx.Response(401, json={"detail": "no"}), "Sentry answered 401"),
        (httpx.Response(200, content=b"x" * (2 * 1024 * 1024 + 1)), "too large"),
        (
            httpx.Response(200, content=b"<html>login</html>"),
            "something else than JSON",
        ),
    ],
)
def test_a_bad_sentry_answer_fails_the_feed(
    runner, sentry, tmp_path: Path, response, message: str
) -> None:
    sentry["handler"] = lambda _request: response

    with pytest.raises(FeedError) as error:
        _sentry_feed(runner, tmp_path)

    assert error.value.reason == "source_failed"
    assert message in str(error.value)
    # A redirect is never followed.
    assert len(sentry["sent"]) == 1


def test_sentry_unreachable(runner, sentry, tmp_path: Path) -> None:
    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    sentry["handler"] = refuse

    with pytest.raises(FeedError, match="Sentry unreachable"):
        _sentry_feed(runner, tmp_path)

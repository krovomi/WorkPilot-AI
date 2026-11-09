"""Server mode: a « production incident » rule (F187, #384).

The server reads the project's incident inbox in its clone and, when the rule
names a Sentry project, Sentry with the Sentry token of the person who saved
the rule, on sentry.io or a host the operator listed. Each incident becomes
one bug-fix card written by *Automations*; nothing listens for Sentry.
"""

from __future__ import annotations

import json
import os
import time
from typing import Any

import pytest

from tests.backend.test_server_automations import (  # noqa: F401  (fixtures)
    _cards,
    _db,
    _pass,
    _rule,
    _save,
    _state,
    world,
)

_ADA_SENTRY = "sntryu_" + "C" * 40  # pragma: allowlist secret

PAYLOAD = {
    "event": {
        "event_id": "evt-1",
        "title": "ZeroDivisionError: division by zero",
        "exception": {
            "values": [
                {
                    "type": "ZeroDivisionError",
                    "value": "division by zero",
                    "stacktrace": {
                        "frames": [
                            {"filename": "shop/price.py", "function": "unit", "lineno": 4}
                        ]
                    },
                }
            ]
        },
    }
}


def _incident_rule(**trigger: Any) -> dict[str, Any]:
    return _rule(name="Prod", trigger={"type": "prod_incident", **trigger})


def _drop(world, name: str, payload: object, mtime: float | None = None) -> None:
    inbox = world["clones"]["shop"] / ".workpilot" / "incidents"
    inbox.mkdir(parents=True, exist_ok=True)
    path = inbox / name
    path.write_text(json.dumps(payload), encoding="utf-8")
    stamp = mtime if mtime is not None else time.time() + 60
    os.utime(path, (stamp, stamp))


async def _sentry_token(user: str = "u-ada") -> None:
    from server.services.secrets import set_user_secret

    async with _db() as db:
        await set_user_secret(db, user, "sentry_token", _ADA_SENTRY)


def test_an_incident_rule_is_a_bug_fix_on_a_checked_sentry_project():
    from shared_features.automations.rules import RuleError, parse_rule

    rule = parse_rule(_incident_rule())
    assert rule["trigger"] == {"type": "prod_incident"} and rule["kind"] == "bug_fix"
    named = parse_rule(_incident_rule(org="acme", project="shop-api", host=""))
    assert named["trigger"] == {"type": "prod_incident", "org": "acme", "project": "shop-api"}
    for bad in (
        {"org": "acme"},
        {"host": "sentry.acme.test"},
        {"org": "acme", "project": "api", "host": "https://sentry.acme.test"},
    ):
        with pytest.raises(RuleError):
            parse_rule(_incident_rule(**bad))


def test_the_incident_patterns_are_the_desktop_s_and_the_feed_s():
    import re
    from pathlib import Path

    from regression_guardian import feed
    from shared_features.automations import rules

    source = (
        Path(__file__).resolve().parents[2]
        / "apps/frontend/src/main/automations/rules.ts"
    ).read_text(encoding="utf-8")
    for name, pattern, mirror in (
        ("SLUG", rules.SLUG, feed._SLUG),
        ("HOST", rules.HOST, feed._HOST),
    ):
        found = re.search(rf"const {name} = (.+?);\n", source)
        assert found, name
        assert found.group(1).replace("\\/", "/") == f"/{pattern.pattern}/"
        assert mirror.pattern == pattern.pattern


async def test_an_incident_in_the_inbox_makes_one_bug_card(world):
    await _save(world, _incident_rule())
    _drop(world, "zero.json", PAYLOAD)
    _drop(world, "old.json", {**PAYLOAD, "event": {**PAYLOAD["event"], "event_id": "old"}}, mtime=1)

    assert (await _pass(world)).created == 1
    assert (await _pass(world)).created == 0
    ((_, card),) = _cards(world).items()
    assert card["metadata"]["kind"] == "bug_fix"
    requirements = json.dumps(card["requirements"])
    assert "shop/price.py:4" in requirements and "**fails**" in requirements
    activity = (await _state(world))["activity"]
    assert any(a.get("reason") == "incident_predates_rule" for a in activity)
    assert world["forge"].sent == []


async def test_a_sentry_rule_reads_with_its_owner_s_sentry_token(world):
    rule_id = (await _save(world, _incident_rule(org="acme", project="shop-api")))[
        "rules"
    ][0]["id"]
    await _pass(world)
    assert (await _state(world))["statuses"][rule_id]["lastError"] == "sentry_token_missing"
    assert world["forge"].sent == []

    await _sentry_token()
    forge = world["forge"]
    forge.answers = {
        "/api/0/projects/acme/shop-api/issues/": [
            {
                "id": "4242",
                "title": "TypeError: price is None",
                "permalink": "https://acme.sentry.io/issues/4242/",
            }
        ],
        "/api/0/issues/4242/events/latest/": {"entries": []},
    }
    assert (await _pass(world)).created == 1
    assert all(r.url.host == "sentry.io" for r in forge.sent)
    assert all(r.headers["Authorization"] == f"Bearer {_ADA_SENTRY}" for r in forge.sent)
    status = (await _state(world))["statuses"][rule_id]
    assert "lastError" not in status


async def test_a_self_hosted_sentry_must_be_listed_by_the_operator(world, monkeypatch):
    from server import config as server_config

    await _sentry_token()
    rule_id = (
        await _save(
            world, _incident_rule(org="acme", project="api", host="sentry.acme.test")
        )
    )["rules"][0]["id"]
    await _pass(world)
    status = (await _state(world))["statuses"][rule_id]
    assert status["lastError"] == "source_failed"
    assert world["forge"].sent == []

    monkeypatch.setenv("WORKPILOT_SENTRY_HOSTS", "sentry.acme.test")
    server_config.reset_settings_cache()
    world["forge"].answers = {"/api/0/projects/acme/api/issues/": []}
    await _pass(world)
    assert "lastError" not in (await _state(world))["statuses"][rule_id]
    assert [r.url.host for r in world["forge"].sent] == ["sentry.acme.test"]

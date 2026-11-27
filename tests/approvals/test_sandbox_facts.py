"""K1: the task's sandbox and the hosts it refused, as approval facts."""

from __future__ import annotations

import json

import pytest
from approvals.conditions import evaluate, parse_condition
from approvals.decide import decide
from approvals.facts import build_facts
from approvals.model import ChangedFile, Tier
from approvals.policy import ApprovalPolicy, parse_approvals
from os_sandbox import evidence
from os_sandbox.evidence import (
    EVIDENCE_FILE,
    kind_of,
    read_evidence,
    record_refused,
    record_session,
)

ENFORCE = ApprovalPolicy(mode="enforce")
FIX = [ChangedFile("src/app.py", 4, 0)]


def _facts(**kw):
    return build_facts(FIX, title="fix: x", ci="green", review="agree", **kw)


def _codes(decision):
    return {r.code for r in decision.reasons}


@pytest.mark.parametrize(
    ("state", "backend", "kind"),
    [
        ("isolated", "microvm", "microvm"),
        ("isolated", "bubblewrap", "os"),
        ("delegated", "Claude Code", "os"),
        ("off", None, "none"),
        ("unavailable", "AppContainer", "none"),
    ],
)
def test_the_kind_of_a_session(state, backend, kind):
    assert kind_of(state, backend) == kind


def test_a_microvm_or_os_sandbox_keeps_the_tier():
    for sandbox in ("microvm", "os", None):
        d = decide(_facts(sandbox=sandbox, blocked_hosts=[]), ENFORCE)
        assert (d.tier, d.action) == (Tier.REVIEW, "merge"), sandbox


def test_no_sandbox_or_a_refused_host_needs_a_person():
    d = decide(_facts(sandbox="none"), ENFORCE)
    assert d.tier == Tier.HUMAN and "unsandboxed" in _codes(d)
    d = decide(_facts(sandbox="microvm", blocked_hosts=["evil.example:443"]), ENFORCE)
    assert d.tier == Tier.HUMAN and "blocked_hosts" in _codes(d)
    assert "evil.example:443" in next(
        r.detail for r in d.reasons if r.code == "blocked_hosts"
    )


def test_the_facts_are_bounded_and_carried():
    f = _facts(sandbox="docker", blocked_hosts=[f"h{i}.example" for i in range(80)])
    assert f.sandbox is None and len(f.blocked_hosts) == 50
    assert f.to_dict()["blockedHosts"][0] == "h0.example"
    assert _facts().to_dict()["blockedHosts"] is None
    assert _facts(sandbox="os").to_dict()["sandbox"] == "os"


def test_the_grammar_reads_the_sandbox_and_hosts():
    vm = _facts(sandbox="microvm", blocked_hosts=["pypi.org"])
    assert evaluate(parse_condition("task/sandbox = microvm"), vm)
    assert evaluate(parse_condition("task/blocked_hosts HAS 'pypi.org'"), vm)
    unknown = _facts()
    # An unknown fact satisfies no comparison, not even a negative one.
    assert not evaluate(parse_condition("task/sandbox != microvm"), unknown)
    assert not evaluate(parse_condition("task/blocked_hosts HAS x"), unknown)


def test_a_rule_can_require_the_microvm():
    policy = parse_approvals(
        {
            "approvals": {
                "rules": [
                    {
                        "purpose": "outside a microVM a person looks",
                        "paths": ["**"],
                        "if": "NOT task/sandbox = microvm",
                        "tier": "human",
                    }
                ]
            }
        },
        source="workpilot.policy.yaml",
    )
    assert not policy.errors
    assert decide(_facts(sandbox="os"), policy).tier == Tier.HUMAN
    assert decide(_facts(sandbox="microvm"), policy).tier == Tier.REVIEW


def test_the_evidence_is_kept_in_every_copy_of_the_spec(tmp_path):
    root = tmp_path / "project"
    main = root / ".workpilot" / "specs" / "001-x"
    own = (
        root
        / ".workpilot"
        / "worktrees"
        / "tasks"
        / "001-x"
        / ".workpilot"
        / "specs"
        / "001-x"
    )
    main.mkdir(parents=True)
    own.mkdir(parents=True)
    record_session(own, "openai", "isolated", "microvm")
    record_session(own, "claude", "delegated", "Claude Code")
    record_refused(own, ["pypi.org:443", "pypi.org:443", "bad host!"])
    for folder in (own, main):
        assert read_evidence(folder) == ("os", ["pypi.org:443"])
    record_session(own, "ollama", "off", None)
    assert read_evidence(main)[0] == "none"


def test_nothing_recorded_or_unreadable_is_unknown(tmp_path):
    assert read_evidence(tmp_path) == (None, None)
    (tmp_path / EVIDENCE_FILE).write_text("[1]", encoding="utf-8")
    assert read_evidence(tmp_path) == (None, None)
    (tmp_path / EVIDENCE_FILE).write_text(
        json.dumps({"sessions": "x", "blockedHosts": "y"}), encoding="utf-8"
    )
    assert read_evidence(tmp_path) == (None, [])
    (tmp_path / EVIDENCE_FILE).write_text(
        json.dumps({"sessions": [{"kind": "weird"}, 3], "blockedHosts": [1, "a.b"]}),
        encoding="utf-8",
    )
    assert read_evidence(tmp_path) == (None, ["a.b"])


def test_no_spec_or_no_host_writes_nothing(tmp_path):
    record_session(None, "openai", "off", None)
    record_refused(None, ["a.b"])
    record_refused(tmp_path, [])
    assert not (tmp_path / EVIDENCE_FILE).exists()


def test_a_record_that_cannot_be_written_is_lost_never_fatal(tmp_path):
    target = tmp_path / "elsewhere.json"
    target.write_text("{}", encoding="utf-8")
    (tmp_path / EVIDENCE_FILE).symlink_to(target)
    record_session(tmp_path, "openai", "off", None)
    assert target.read_text(encoding="utf-8") == "{}"
    other = tmp_path / "other"
    other.mkdir()
    (other / "sandbox_evidence.json.partial").mkdir()
    record_refused(other, ["a.b"])
    assert not (other / EVIDENCE_FILE).exists()
    assert evidence.MAX_HOSTS == 50

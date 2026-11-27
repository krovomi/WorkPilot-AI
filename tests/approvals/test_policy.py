"""The ``approvals`` section: strict schema; a wrong one is an error list."""

from __future__ import annotations

import pytest
from approvals.model import Tier
from approvals.policy import parse_approvals


def test_no_section_gives_the_built_in_tiers_with_no_mode_of_its_own():
    policy = parse_approvals(
        {"version": 1, "rules": []}, source="workpilot.policy.yaml"
    )
    assert not policy.declared
    assert policy.mode == ""
    assert policy.errors == ()
    assert (
        policy.max_files,
        policy.max_lines,
        policy.max_layers,
        policy.min_trust,
    ) == (
        20,
        400,
        1,
        60,
    )
    assert parse_approvals(None).mode == ""


def test_a_full_section_is_read():
    policy = parse_approvals(
        {
            "approvals": {
                "mode": "enforce",
                "require_review": False,
                "major_bumps": "auto",
                "limits": {
                    "max_files": 5,
                    "max_lines": 50,
                    "max_layers": 2,
                    "min_trust": 80,
                },
                "sensitive": ["src/Billing/**"],
                "rules": [
                    {
                        "purpose": "Billing goes through a person",
                        "paths": ["src/Billing/**", "!src/Billing/**/*.md"],
                        "if": "pr/type != docs",
                        "tier": "human",
                    },
                    {"purpose": "Infra", "paths": ["infra/**"], "tier": "N3"},
                ],
            }
        }
    )
    assert policy.errors == ()
    assert policy.mode == "enforce" and policy.require_review is False
    assert policy.major_bumps == "auto"
    assert (
        policy.max_files,
        policy.max_lines,
        policy.max_layers,
        policy.min_trust,
    ) == (5, 50, 2, 80)
    assert policy.sensitive == ("src/Billing/**",)
    first, second = policy.rules
    assert first.include == ("src/Billing/**",) and first.exclude == (
        "src/Billing/**/*.md",
    )
    assert first.tier == Tier.HUMAN and first.condition is not None
    assert second.tier == Tier.LOCKED and second.condition is None


@pytest.mark.parametrize(
    ("section", "fragment"),
    [
        ("yes", "must be a mapping"),
        ({"mode": "always"}, "approvals.mode"),
        ({"surprise": 1}, "unknown key 'approvals.surprise'"),
        ({"require_review": "yes"}, "require_review"),
        ({"major_bumps": "maybe"}, "major_bumps"),
        ({"limits": {"max_files": 0}}, "max_files"),
        ({"limits": {"max_lines": True}}, "max_lines"),
        ({"limits": {"min_trust": 101}}, "min_trust"),
        ({"limits": {"other": 1}}, "approvals.limits.other"),
        ({"limits": []}, "approvals.limits"),
        ({"sensitive": ["/etc/**"]}, "not a glob"),
        ({"sensitive": ["../x"]}, "not a glob"),
        ({"sensitive": ["C:/x"]}, "not a glob"),
        ({"sensitive": ["!x/**"]}, "no '!'"),
        ({"sensitive": "x/**"}, "list of at most"),
        ({"rules": {}}, "list of at most"),
        ({"rules": ["x"]}, "must be a mapping"),
        ({"rules": [{"paths": ["**"], "tier": "human"}]}, "'purpose' is required"),
        (
            {"rules": [{"purpose": "p", "paths": ["!x"], "tier": "human"}]},
            "without '!'",
        ),
        ({"rules": [{"purpose": "p", "paths": ["**"], "tier": "auto"}]}, "stricter"),
        ({"rules": [{"purpose": "p", "paths": ["**"], "tier": "maybe"}]}, "'tier'"),
        (
            {
                "rules": [
                    {"purpose": "p", "paths": ["**"], "tier": "human", "if": "x ="}
                ]
            },
            ".if:",
        ),
        (
            {
                "rules": [
                    {"purpose": "p", "paths": ["**"], "tier": "human", "when": "1"}
                ]
            },
            "unknown key 'when'",
        ),
    ],
)
def test_a_wrong_section_is_an_error_never_a_partial_policy(section, fragment):
    policy = parse_approvals({"approvals": section})
    assert policy.declared
    assert any(fragment in e for e in policy.errors), policy.errors

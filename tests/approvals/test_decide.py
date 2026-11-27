"""``decide``: the tiers N0 to N3 and the action they allow now."""

from __future__ import annotations

from dataclasses import replace

import pytest
from approvals.decide import decide
from approvals.facts import build_facts
from approvals.model import ChangedFile, Tier
from approvals.policy import ApprovalPolicy, parse_approvals

ENFORCE = ApprovalPolicy(mode="enforce")


def _decide(paths, title="fix: x", policy=ENFORCE, lines=4, **kw):
    files = [ChangedFile(p, lines, 0) for p in paths]
    facts = build_facts(
        files,
        title=title,
        ci=kw.pop("ci", "green"),
        review=kw.pop("review", "agree"),
        **kw,
    )
    return decide(facts, policy)


def _codes(decision):
    return {r.code for r in decision.reasons}


def test_a_patch_bump_with_green_ci_merges_alone():
    d = _decide(
        ["package.json", "pnpm-lock.yaml"],
        "chore(deps): bump vite from 7.1.2 to 7.1.3",
        review="none",
    )
    assert (d.tier, d.action, d.merges) == (Tier.AUTO, "merge", True)


def test_a_bump_waits_for_the_ci_and_a_red_ci_blocks():
    title = "chore(deps): bump vite from 7.1.2 to 7.2.0"
    assert _decide(["package.json"], title, ci="pending").action == "wait"
    assert _decide(["package.json"], title, ci="unknown").action == "wait"
    assert _decide(["package.json"], title, ci="red").action == "blocked"


def test_a_major_bump_goes_to_a_person_unless_the_policy_allows_it():
    title = "chore(deps): bump vite from 7.1.2 to 8.0.0"
    d = _decide(["package.json"], title)
    assert (d.tier, d.action) == (Tier.HUMAN, "human") and "major_bump" in _codes(d)
    auto = _decide(["package.json"], title, policy=replace(ENFORCE, major_bumps="auto"))
    assert auto.tier == Tier.AUTO


def test_a_bump_without_versions_or_with_code_needs_the_review():
    unknown = _decide(["package.json"], "chore(deps): bump the npm group")
    assert unknown.tier == Tier.REVIEW and "bump_unknown" in _codes(unknown)
    with_code = _decide(
        ["package.json", "src/app.ts"], "chore(deps): bump x from 1.0.0 to 1.0.1"
    )
    assert with_code.tier == Tier.REVIEW and "bump_with_code" in _codes(with_code)


def test_a_bump_of_ci_actions_goes_to_a_person_other_ci_changes_are_locked():
    bump = _decide(
        [".github/workflows/ci.yml"],
        "chore(deps): bump actions/checkout from 4.1.0 to 4.2.0",
    )
    assert bump.tier == Tier.HUMAN and "ci_files_bump" in _codes(bump)
    edit = _decide([".github/workflows/ci.yml"], "fix: ci")
    assert edit.tier == Tier.LOCKED and "ci_files" in _codes(edit)


def test_documentation_only_merges_alone():
    d = _decide(["docs/guide.md", "README.md"], "docs: guide", review="none")
    assert (d.tier, d.action) == (Tier.AUTO, "merge")


def test_a_one_layer_fix_merges_after_an_agreeing_review():
    d = _decide(["src/app/service.py"], "fix: null check")
    assert (d.tier, d.action, d.merges) == (Tier.REVIEW, "merge", True)


@pytest.mark.parametrize(
    ("review", "action", "code"),
    [
        ("disagree", "blocked", None),
        ("inconclusive", "human", "review_inconclusive"),
        ("none", "human", "review_missing"),
    ],
)
def test_n1_needs_an_agreeing_review(review, action, code):
    d = _decide(["src/app/service.py"], "fix: x", review=review)
    assert d.tier == Tier.REVIEW and d.action == action
    if code:
        assert code in _codes(d)


def test_without_require_review_n1_merges_on_green_ci():
    d = _decide(
        ["src/app/x.py"],
        "fix: x",
        review="none",
        policy=replace(ENFORCE, require_review=False),
    )
    assert d.action == "merge"


@pytest.mark.parametrize(
    ("paths", "title", "code"),
    [
        (["src/app/x.py"], "feat: orders", "feature"),
        (["src/app/x.py"], "fix!: drop v1", "breaking"),
        (["apps/backend/x.py", "apps/frontend/y.ts"], "fix: x", "layers"),
        (["db/migrations/0042_add.py"], "fix: x", "migration"),
        (["api/openapi.yaml"], "fix: x", "contract"),
        (["protos/orders.proto"], "fix: x", "contract"),
    ],
)
def test_human_tier_triggers(paths, title, code):
    d = _decide(paths, title)
    assert d.tier == Tier.HUMAN and d.action == "human" and code in _codes(d)


def test_size_limits_and_trust_raise_to_human():
    many = _decide([f"src/app/f{i}.py" for i in range(21)], "fix: x")
    assert "size_files" in _codes(many)
    long = _decide(["src/app/x.py"], "fix: x", lines=401)
    assert "size_lines" in _codes(long)
    low = _decide(["src/app/x.py"], "fix: x", trust=40)
    assert low.tier == Tier.HUMAN and "trust" in _codes(low)
    unknown_trust = _decide(["src/app/x.py"], "fix: x")
    assert "trust" not in _codes(unknown_trust)


@pytest.mark.parametrize(
    "path",
    [
        "src/Shop.Infrastructure/Auth/JwtIssuer.cs",
        "app/.env.production",
        "config/ClientSecrets.json",
        "src/payments/stripe.ts",
        "certs/server.pem",
        "lib/crypto_box.go",
        "src/Customers/PersonalDataExport.cs",
        "AGENTS.md",
        "apps/web/CLAUDE.md",
        ".claude/approvals.yml",
        "workpilot.policy.yaml",
        ".github/CODEOWNERS",
        ".gitattributes",
    ],
)
def test_sensitive_and_protected_paths_are_locked(path):
    d = _decide([path], "fix: x")
    assert (d.tier, d.action) == (Tier.LOCKED, "human")


def test_requires_review_and_policy_sensitive_paths_are_locked():
    policy = replace(
        ENFORCE, requires_review=("infra/**",), sensitive=("src/Ledger/**",)
    )
    assert _decide(["infra/main.tf"], policy=policy).tier == Tier.LOCKED
    assert _decide(["src/Ledger/Book.cs"], policy=policy).tier == Tier.LOCKED


def test_rules_only_raise_and_respect_their_condition_and_exclusions():
    policy = replace(
        parse_approvals(
            {
                "approvals": {
                    "rules": [
                        {
                            "purpose": "Orders goes through a person",
                            "paths": ["src/Orders/**", "!src/Orders/**/*.md"],
                            "if": "rule/files_changed >= 1 AND pr/type != docs",
                            "tier": "human",
                        }
                    ]
                }
            }
        ),
        mode="enforce",
    )
    raised = _decide(["src/Orders/Invoice.cs"], policy=policy)
    assert raised.tier == Tier.HUMAN and "rule" in _codes(raised)
    excluded = _decide(["src/Orders/notes.md"], "docs: x", policy=policy, review="none")
    assert excluded.tier == Tier.AUTO
    elsewhere = _decide(["src/Catalog/Item.cs"], policy=policy)
    assert elsewhere.tier == Tier.REVIEW


def test_an_invalid_policy_is_locked_and_never_merges():
    policy = replace(parse_approvals({"approvals": {"mode": "always"}}), mode="enforce")
    d = _decide(["docs/a.md"], "docs: a", policy=policy)
    assert (d.tier, d.action, d.merges) == (Tier.LOCKED, "human", False)
    assert d.errors and "policy_invalid" in _codes(d)


def test_observe_reports_and_off_never_merges():
    title = "chore(deps): bump vite from 7.1.2 to 7.1.3"
    observe = _decide(["package.json"], title, policy=ApprovalPolicy(mode="observe"))
    assert observe.action == "merge" and observe.merges is False
    off = _decide(["package.json"], title, policy=ApprovalPolicy(mode="off"))
    assert off.action == "human" and off.merges is False


def test_an_empty_change_goes_to_a_person():
    d = decide(build_facts([], title="fix: x", ci="green", review="agree"), ENFORCE)
    assert d.tier == Tier.HUMAN and "empty" in _codes(d)


def test_the_decision_serializes_with_its_strictest_reason_first():
    d = _decide(["AGENTS.md", "src/app/x.py"], "feat: x")
    data = d.to_dict()
    assert data["tier"] == "N3" and data["tierName"] == "locked"
    assert data["reasons"][0]["tier"] == "N3"
    assert data["facts"]["type"] == "feat" and data["merges"] is False

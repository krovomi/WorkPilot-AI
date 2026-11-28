"""``decide``: the tier of a pull request and what to do with it now.

Pure: facts and a policy in, a decision out, no I/O. The order is the design:

1. An invalid ``approvals`` section is LOCKED: a typo never allows a merge.
2. Built-in tiers, the strictest one a file or a fact reaches:
   - LOCKED (N3): sensitive paths (secrets, auth, crypto, personal data,
     payment), the policy and agent instruction files, the paths
     ``files.requires_review`` names, and CI files outside a dependency bump;
   - HUMAN (N2): a feature or a breaking change, more layers or files or lines
     than the limits, a database migration, a public contract (OpenAPI,
     protobuf, GraphQL), a trust score under the limit, a major bump, a bump
     that also touches CI;
   - AUTO (N0): a dependency bump whose files are manifests, lockfiles and
     text; a change of documentation only;
   - REVIEW (N1): anything else.
3. The policy's rules, which can only raise the tier.
4. The action, from the tier and the checks: a red CI or a disagreeing review
   blocks; N2 and N3 wait for a person; N0 and N1 merge once the CI is green
   (and, for N1, once the cross-review agreed when ``require_review``).
5. The mode: ``off`` never merges, ``observe`` reports what would happen,
   ``enforce`` lets the caller merge (``Decision.merges``).
"""

from __future__ import annotations

from collections.abc import Callable, Iterable

from foundation.change_scope import is_text_only_path
from security.guardrails import glob_to_regex

from .conditions import evaluate
from .facts import is_ci_file, is_dependency_file
from .model import (
    ACTION_BLOCKED,
    ACTION_HUMAN,
    ACTION_MERGE,
    ACTION_WAIT,
    MODE_OFF,
    Decision,
    PRFacts,
    Reason,
    Tier,
)
from .policy import ApprovalPolicy, Rule

#: Sensitive paths, matched in lower case: N3 whatever the type of change.
SENSITIVE_GLOBS = (
    "**/.env",
    "**/.env.*",
    "**/*secret*",
    "**/*secret*/**",
    "**/*credential*",
    "**/*credential*/**",
    "**/*password*",
    "**/auth/**",
    "**/authz/**",
    "**/authentication/**",
    "**/authorization/**",
    "**/identity/**",
    "**/oauth/**",
    "**/*crypto*",
    "**/*crypto*/**",
    "**/security/**",
    "**/*.pem",
    "**/*.key",
    "**/*.pfx",
    "**/*.p12",
    "**/*.jks",
    "**/payment*/**",
    "**/billing/**",
    "**/*gdpr*",
    "**/*rgpd*",
    "**/*personaldata*",
    "**/*pii*",
)
#: Files that decide how agents work or who approves: N3.
PROTECTED_GLOBS = (
    "workpilot.policy.yaml",
    "workpilot.policy.yml",
    "**/.claude/**",
    "**/claude.md",
    "**/agents.md",
    "**/codeowners",
    ".gitattributes",
    "**/.gitattributes",
    ".gitmodules",
    "review.md",
    ".mcp.json",
    "**/.mcp.json",
)
MIGRATION_GLOBS = (
    "**/migrations/**",
    "**/alembic/**",
    "**/migration/**",
    "**/db/migrate/**",
    "**/flyway/**",
    "**/liquibase/**",
    "**/*.sql",
)
CONTRACT_GLOBS = (
    "**/openapi*.json",
    "**/openapi*.yaml",
    "**/openapi*.yml",
    "**/swagger*.json",
    "**/swagger*.yaml",
    "**/*.proto",
    "**/*.graphql",
    "**/*.graphqls",
    "**/*.avsc",
    "**/asyncapi*.yaml",
)


def _compiled(globs: Iterable[str]) -> list:
    return [glob_to_regex(g.lower()) for g in globs]


_SENSITIVE = _compiled(SENSITIVE_GLOBS)
_PROTECTED = _compiled(PROTECTED_GLOBS)
_MIGRATIONS = _compiled(MIGRATION_GLOBS)
_CONTRACTS = _compiled(CONTRACT_GLOBS)


def _hits(paths: Iterable[str], patterns: list) -> tuple[str, ...]:
    return tuple(p for p in paths if any(rx.match(p.lower()) for rx in patterns))


class _Collector:
    def __init__(self) -> None:
        self.reasons: list[Reason] = []

    def add(
        self, code: str, tier: Tier, detail: str, files: Iterable[str] = ()
    ) -> None:
        self.reasons.append(Reason(code, tier, detail, tuple(files)))

    @property
    def tier(self) -> Tier:
        return max((r.tier for r in self.reasons), default=Tier.REVIEW)


def _built_in(facts: PRFacts, policy: ApprovalPolicy, out: _Collector) -> None:
    paths = facts.paths
    deps = facts.type == "deps"

    sensitive = _hits(paths, _SENSITIVE + _compiled(policy.sensitive))
    if sensitive:
        out.add("sensitive_paths", Tier.LOCKED, "sensitive paths changed", sensitive)
    protected = _hits(paths, _PROTECTED)
    if protected:
        out.add(
            "protected_files",
            Tier.LOCKED,
            "policy or agent instruction files",
            protected,
        )
    if policy.requires_review:
        review = _hits(paths, _compiled(policy.requires_review))
        if review:
            out.add(
                "requires_review", Tier.LOCKED, "files.requires_review paths", review
            )
    ci_files = tuple(p for p in paths if is_ci_file(p))
    if ci_files:
        if deps:
            out.add(
                "ci_files_bump", Tier.HUMAN, "a bump that changes CI files", ci_files
            )
        else:
            out.add("ci_files", Tier.LOCKED, "CI or pipeline files changed", ci_files)

    if facts.type == "feat":
        out.add("feature", Tier.HUMAN, "a new feature")
    if facts.breaking:
        out.add("breaking", Tier.HUMAN, "a breaking change")
    migrations = _hits(paths, _MIGRATIONS)
    if migrations:
        out.add("migration", Tier.HUMAN, "database migration", migrations)
    contracts = _hits(paths, _CONTRACTS)
    if contracts:
        out.add("contract", Tier.HUMAN, "public API contract", contracts)
    if len(facts.layers) > policy.max_layers:
        out.add(
            "layers",
            Tier.HUMAN,
            f"{len(facts.layers)} {facts.layer_source} touched "
            f"(limit {policy.max_layers}): {', '.join(facts.layers[:6])}",
        )
    code = [f for f in facts.files if not is_text_only_path(f.path)]
    if not deps and len(code) > policy.max_files:
        out.add(
            "size_files",
            Tier.HUMAN,
            f"{len(code)} code files (limit {policy.max_files})",
        )
    code_lines = sum(f.lines for f in code)
    if not deps and code_lines > policy.max_lines:
        out.add(
            "size_lines",
            Tier.HUMAN,
            f"{code_lines} changed lines (limit {policy.max_lines})",
        )
    if facts.trust is not None and facts.trust < policy.min_trust:
        out.add(
            "trust", Tier.HUMAN, f"trust score {facts.trust} (limit {policy.min_trust})"
        )
    if facts.sandbox == "none":
        out.add("unsandboxed", Tier.HUMAN, "the task's commands ran without a sandbox")
    if facts.blocked_hosts:
        out.add(
            "blocked_hosts",
            Tier.HUMAN,
            "the sandbox refused hosts to the task: "
            + ", ".join(facts.blocked_hosts[:6]),
        )

    if deps:
        only_deps = all(
            is_dependency_file(p) or is_text_only_path(p) or is_ci_file(p)
            for p in paths
        )
        if facts.bump == "major" and policy.major_bumps == "human":
            out.add("major_bump", Tier.HUMAN, "a major version bump")
        elif not only_deps:
            out.add("bump_with_code", Tier.REVIEW, "a bump that also changes code")
        elif facts.bump in (None, "unknown"):
            out.add(
                "bump_unknown",
                Tier.REVIEW,
                "a bump whose versions the title does not say",
            )
        else:
            out.add(
                "dependency_bump", Tier.AUTO, f"a {facts.bump or 'dependency'} bump"
            )
    elif paths and all(is_text_only_path(p) for p in paths):
        out.add("docs_only", Tier.AUTO, "documentation and text only")
    elif not paths:
        out.add("empty", Tier.HUMAN, "no change could be read")
    else:
        out.add("code_change", Tier.REVIEW, f"a {facts.type} change")


def _rule_files(rule: Rule, paths: Iterable[str]) -> tuple[str, ...]:
    include = _compiled(rule.include)
    exclude = _compiled(rule.exclude)
    return tuple(
        p
        for p in paths
        if any(rx.match(p.lower()) for rx in include)
        and not any(rx.match(p.lower()) for rx in exclude)
    )


def _rules(facts: PRFacts, policy: ApprovalPolicy, out: _Collector) -> None:
    for rule in policy.rules:
        files = _rule_files(rule, facts.paths)
        if not files:
            continue
        if rule.condition is not None and not evaluate(
            rule.condition, facts, len(files)
        ):
            continue
        out.add("rule", rule.tier, rule.purpose, files)


def _action(tier: Tier, facts: PRFacts, policy: ApprovalPolicy, out: _Collector) -> str:
    if facts.ci == "red":
        return ACTION_BLOCKED
    if facts.review == "disagree":
        return ACTION_BLOCKED
    if tier >= Tier.HUMAN:
        return ACTION_HUMAN
    if tier == Tier.REVIEW and facts.review == "inconclusive":
        out.add("review_inconclusive", Tier.REVIEW, "the cross-review could not decide")
        return ACTION_HUMAN
    if tier == Tier.REVIEW and policy.require_review and facts.review == "none":
        out.add("review_missing", Tier.REVIEW, "no cross-review ran on this change")
        return ACTION_HUMAN
    if facts.ci != "green":
        return ACTION_WAIT
    return ACTION_MERGE


def decide(
    facts: PRFacts,
    policy: ApprovalPolicy,
    *,
    extra: Callable[[PRFacts, _Collector], None] | None = None,
) -> Decision:
    """The tier of ``facts`` under ``policy``, and the action it allows now."""
    out = _Collector()
    if policy.errors:
        out.add(
            "policy_invalid",
            Tier.LOCKED,
            f"the approvals section of {policy.source or 'workpilot.policy.yaml'} is invalid",
        )
        return Decision(
            tier=Tier.LOCKED,
            action=ACTION_HUMAN,
            mode=policy.mode,
            reasons=tuple(out.reasons),
            facts=facts,
            errors=policy.errors,
        )
    _built_in(facts, policy, out)
    _rules(facts, policy, out)
    if extra is not None:
        extra(facts, out)
    action = _action(out.tier, facts, policy, out)
    if policy.mode == MODE_OFF and action == ACTION_MERGE:
        action = ACTION_HUMAN
    reasons = sorted(out.reasons, key=lambda r: -int(r.tier))
    return Decision(
        tier=out.tier,
        action=action,
        mode=policy.mode,
        reasons=tuple(reasons),
        facts=facts,
    )


__all__ = [
    "CONTRACT_GLOBS",
    "MIGRATION_GLOBS",
    "PROTECTED_GLOBS",
    "SENSITIVE_GLOBS",
    "decide",
]

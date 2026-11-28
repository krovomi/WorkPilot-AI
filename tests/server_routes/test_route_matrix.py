"""Every route a server serves, and who it lets through.

``RULES`` names, for each (method, route) of the server-mode app, what guards
it. The table is checked against the app itself: a route added without a line
here fails :func:`test_the_table_names_every_route_the_server_serves`, so a new
route cannot ship without someone writing down who may call it. Each kind of
rule is then checked on every route that has it, through the real middleware:

- without a token, or with one the server did not sign, every route but the
  public ones answers 401;
- a route behind a permission refuses, with that permission's name, a member
  of the project whose role grants nothing;
- a route reserved to the platform refuses an organization administrator;
- a route that names a project answers 404 to the people of another
  organization, as for a project that does not exist, and 403 to a person of
  the organization who is not on the project;
- an administrator of the organization reaches every project of it.

These are refusals, checked before anything runs; what each route does when
it lets the caller through is in the other files of this folder.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

import jwt as pyjwt
from fastapi.routing import APIRoute
from server.authz.roles import system_role

from tests.server_routes.world import World


@dataclass(frozen=True)
class Rule:
    """What stands in front of a route.

    ``kind``: ``public`` (no token), ``signed_in`` (any account, its own
    data), ``platform`` (the deployment's administrator), ``admin_role`` (the
    same, by the token's platform role), ``permission`` (``permission`` in the
    organization the caller acts in), ``project`` (a role on the project in
    the path: ``project_role``, and ``permission`` when one is named too),
    ``personal_token`` (``/mcp``: a personal access token, never a session's).
    ``scoped``: the route acts on the project named by ``project_id`` in the
    query string, through ``server.authz.scope``.
    """

    kind: str
    permission: str | None = None
    project_role: str | None = None
    scoped: bool = False


def public() -> Rule:
    return Rule("public")


def signed_in() -> Rule:
    return Rule("signed_in")


def platform() -> Rule:
    return Rule("platform")


def needs(permission: str) -> Rule:
    return Rule("permission", permission=permission)


def scoped(permission: str) -> Rule:
    return Rule("permission", permission=permission, scoped=True)


def project(role: str, permission: str | None = None) -> Rule:
    return Rule("project", permission=permission, project_role=role)


RULES: dict[tuple[str, str], Rule] = {
    # --- Accounts and sessions -------------------------------------------
    ("GET", "/health"): public(),
    ("GET", "/metrics"): public(),
    ("GET", "/auth/config"): public(),
    ("POST", "/auth/login"): public(),
    ("POST", "/auth/oidc/exchange"): public(),
    ("POST", "/auth/sso/exchange"): public(),
    ("POST", "/auth/refresh"): public(),
    ("POST", "/auth/logout"): public(),
    ("POST", "/auth/invitations/lookup"): public(),
    ("POST", "/auth/invitations/accept"): public(),
    ("POST", "/auth/password-reset/request"): public(),
    ("POST", "/auth/password-reset/lookup"): public(),
    ("POST", "/auth/password-reset/confirm"): public(),
    ("GET", "/auth/me"): signed_in(),
    ("GET", "/auth/me/permissions"): signed_in(),
    ("GET", "/auth/me/session"): signed_in(),
    ("POST", "/auth/switch-org"): signed_in(),
    ("POST", "/auth/password"): signed_in(),
    ("POST", "/auth/users"): Rule("admin_role"),
    ("POST", "/auth/invitations"): needs("org.invitation.write"),
    ("GET", "/auth/invitations"): needs("org.invitation.read"),
    ("DELETE", "/auth/invitations/{invitation_id}"): needs("org.invitation.write"),
    # --- A person's own settings ---------------------------------------------
    ("GET", "/users"): signed_in(),
    ("GET", "/users/me/secrets"): signed_in(),
    ("PUT", "/users/me/secrets"): signed_in(),
    ("DELETE", "/users/me/secrets/{kind}"): signed_in(),
    ("PUT", "/users/me/devices"): signed_in(),
    ("DELETE", "/users/me/devices"): signed_in(),
    ("GET", "/users/me/preferences"): signed_in(),
    ("PUT", "/users/me/preferences"): signed_in(),
    ("GET", "/users/me/preferences/menu"): signed_in(),
    ("PUT", "/users/me/preferences/menu"): signed_in(),
    ("GET", "/users/me/page-activity"): signed_in(),
    ("POST", "/users/me/page-activity"): signed_in(),
    ("GET", "/users/me/access-tokens"): signed_in(),
    ("POST", "/users/me/access-tokens"): signed_in(),
    ("DELETE", "/users/me/access-tokens/{token_id}"): signed_in(),
    ("GET", "/users/me/ai-accounts"): needs("settings.account.read"),
    ("POST", "/users/me/ai-accounts"): needs("settings.account.write"),
    ("PATCH", "/users/me/ai-accounts/{account_id}"): needs("settings.account.write"),
    ("DELETE", "/users/me/ai-accounts/{account_id}"): needs("settings.account.write"),
    ("PUT", "/users/me/ai-accounts/defaults/{provider}"): needs(
        "settings.account.write"
    ),
    ("GET", "/users/me/needs-you"): needs("task.read"),
    ("PUT", "/users/me/needs-you/channels/{channel}"): needs("agent.execute"),
    ("DELETE", "/users/me/needs-you/channels/{channel}"): needs("task.read"),
    ("POST", "/users/me/needs-you/channels/{channel}/test"): needs("agent.execute"),
    ("PUT", "/users/me/needs-you/preferences"): needs("task.read"),
    # --- Projects, their members, specs and runs ------------------------------
    ("GET", "/projects"): signed_in(),
    ("POST", "/projects"): signed_in(),
    ("GET", "/projects/{project_id}"): project("viewer"),
    ("DELETE", "/projects/{project_id}"): project("owner"),
    ("GET", "/projects/{project_id}/members"): project("viewer"),
    ("POST", "/projects/{project_id}/members"): project("owner"),
    ("DELETE", "/projects/{project_id}/members/{member_user_id}"): project("owner"),
    ("GET", "/projects/{project_id}/specs"): project("viewer"),
    ("GET", "/projects/{project_id}/specs/{spec_id}/runs"): project("viewer"),
    ("POST", "/projects/{project_id}/specs/{spec_id}/claim"): project(
        "member", "task.claim"
    ),
    ("POST", "/projects/{project_id}/specs/{spec_id}/release"): project(
        "member", "task.claim"
    ),
    ("POST", "/projects/{project_id}/specs/{spec_id}/runs"): project(
        "member", "agent.execute"
    ),
    ("POST", "/projects/{project_id}/specs/{spec_id}/runs/{run_id}/cancel"): project(
        "member", "agent.cancel"
    ),
    # --- Administration --------------------------------------------------------
    ("GET", "/admin/orgs"): platform(),
    ("POST", "/admin/orgs"): platform(),
    ("PATCH", "/admin/orgs/{target_org_id}"): platform(),
    ("DELETE", "/admin/orgs/{target_org_id}"): platform(),
    ("POST", "/admin/users/{user_id}/platform-role"): platform(),
    ("POST", "/admin/users/{user_id}/password-reset"): platform(),
    ("GET", "/admin/members"): needs("org.member.read"),
    ("POST", "/admin/members"): needs("org.member.write"),
    ("PATCH", "/admin/members/{member_user_id}"): needs("org.member.write"),
    ("DELETE", "/admin/members/{member_user_id}"): needs("org.member.write"),
    ("GET", "/admin/permissions"): needs("org.role.read"),
    ("GET", "/admin/roles"): needs("org.role.read"),
    ("POST", "/admin/roles"): needs("org.role.write"),
    ("PATCH", "/admin/roles/{role_id}"): needs("org.role.write"),
    ("DELETE", "/admin/roles/{role_id}"): needs("org.role.write"),
    ("GET", "/admin/users"): needs("org.member.read"),
    ("POST", "/admin/users/{user_id}/deactivate"): needs("org.member.write"),
    ("POST", "/admin/users/{user_id}/activate"): needs("org.member.write"),
    ("GET", "/admin/sessions"): needs("org.session.read"),
    ("DELETE", "/admin/sessions/{user_id}"): needs("org.session.revoke"),
    ("GET", "/admin/groups"): needs("org.member.read"),
    ("POST", "/admin/groups"): needs("org.member.write"),
    ("PATCH", "/admin/groups/{group_id}"): needs("org.member.write"),
    ("DELETE", "/admin/groups/{group_id}"): needs("org.member.write"),
    ("PUT", "/admin/groups/{group_id}/members/{member_user_id}"): needs(
        "org.member.write"
    ),
    ("DELETE", "/admin/groups/{group_id}/members/{member_user_id}"): needs(
        "org.member.write"
    ),
    ("PUT", "/admin/groups/{group_id}/projects/{project_id}"): needs(
        "project.member.write"
    ),
    ("DELETE", "/admin/groups/{group_id}/projects/{project_id}"): needs(
        "project.member.write"
    ),
    ("GET", "/admin/overview"): needs("analytics.read"),
    ("GET", "/admin/quotas"): needs("org.quota.read"),
    ("PUT", "/admin/quotas"): needs("org.quota.write"),
    ("GET", "/admin/usage/settings"): needs("usage.read"),
    ("PUT", "/admin/usage/settings"): needs("usage.write"),
    ("GET", "/admin/usage/summary"): needs("usage.read"),
    ("GET", "/admin/usage/daily"): needs("usage.read"),
    ("GET", "/admin/usage/people"): needs("usage.read"),
    ("GET", "/admin/usage/people/{person_id}"): needs("usage.read"),
    ("GET", "/admin/usage/models"): needs("usage.read"),
    ("GET", "/admin/usage/projects"): needs("usage.read"),
    ("GET", "/admin/usage/pages"): needs("usage.read"),
    ("GET", "/admin/usage/delivery"): needs("usage.read"),
    ("GET", "/admin/usage/presence"): needs("usage.read"),
    ("GET", "/admin/usage/export"): needs("usage.read"),
    ("GET", "/admin/platform/health"): platform(),
    ("GET", "/admin/usage/report/settings"): needs("usage.read"),
    ("PUT", "/admin/usage/report/settings"): needs("usage.write"),
    ("GET", "/admin/usage/report"): needs("usage.read"),
    ("POST", "/admin/usage/report/send"): needs("usage.write"),
    ("GET", "/admin/usage/budgets"): needs("usage.read"),
    ("PUT", "/admin/usage/budgets"): needs("usage.write"),
    ("DELETE", "/admin/usage/budgets/{budget_id}"): needs("usage.write"),
    ("GET", "/admin/platform/usage/summary"): platform(),
    ("GET", "/admin/platform/usage/daily"): platform(),
    ("GET", "/admin/platform/usage/people"): platform(),
    ("GET", "/admin/platform/usage/people/{person_id}"): platform(),
    ("GET", "/admin/platform/usage/models"): platform(),
    ("GET", "/admin/platform/usage/projects"): platform(),
    ("GET", "/admin/platform/usage/pages"): platform(),
    ("GET", "/admin/platform/usage/delivery"): platform(),
    ("GET", "/admin/platform/usage/presence"): platform(),
    ("GET", "/admin/platform/usage/export"): platform(),
    ("GET", "/users/me/usage"): signed_in(),
    ("GET", "/users/me/usage/export"): signed_in(),
    ("GET", "/users/me/usage-notice"): signed_in(),
    ("POST", "/users/me/usage-notice"): signed_in(),
    ("POST", "/admin/users/{user_id}/erase"): platform(),
    ("GET", "/admin/audit"): needs("audit.read"),
    # --- The shared board ------------------------------------------------------
    ("GET", "/api/board/stream"): needs("task.read"),
    ("GET", "/api/board/snapshot"): scoped("task.read"),
    ("GET", "/api/board/mobile-profile"): scoped("task.read"),
    ("GET", "/api/board/engines"): scoped("task.read"),
    ("GET", "/api/board/cards"): scoped("task.read"),
    ("POST", "/api/board/cards"): scoped("task.write"),
    ("GET", "/api/board/cards/{card_id}"): scoped("task.read"),
    ("PATCH", "/api/board/cards/{card_id}"): scoped("task.write"),
    ("DELETE", "/api/board/cards/{card_id}"): scoped("task.delete"),
    ("GET", "/api/board/cards/{card_id}/logs"): scoped("task.read"),
    ("PATCH", "/api/board/cards/{card_id}/settings"): scoped("task.write"),
    ("POST", "/api/board/cards/{card_id}/approve"): scoped("review.approve"),
    ("GET", "/api/board/cards/{card_id}/changes"): scoped("task.read"),
    ("POST", "/api/board/cards/{card_id}/request-changes"): scoped("review.approve"),
    ("GET", "/api/board/cards/{card_id}/approvals"): scoped("task.read"),
    ("PUT", "/api/board/cards/{card_id}/criticality"): scoped("review.approve"),
    ("GET", "/api/board/delegations"): scoped("task.read"),
    ("POST", "/api/board/delegations"): scoped("review.approve"),
    ("DELETE", "/api/board/delegations/{delegation_id}"): scoped("review.approve"),
    ("POST", "/api/board/cards/{card_id}/subtasks/{subtask_id}/unblock"): scoped(
        "task.write"
    ),
    ("GET", "/api/board/cards/{card_id}/captures"): scoped("task.read"),
    ("GET", "/api/board/cards/{card_id}/captures/{index}/{side}"): scoped("task.read"),
    ("POST", "/api/board/cards/{card_id}/captures/publish"): scoped("review.approve"),
    ("POST", "/api/board/cards/{card_id}/captures/withdraw"): scoped("review.approve"),
    ("GET", "/api/board/cards/{card_id}/steering"): scoped("task.read"),
    ("POST", "/api/board/cards/{card_id}/steering"): scoped("agent.execute"),
    ("POST", "/api/board/cards/{card_id}/task-token"): scoped("task.write"),
    ("GET", "/api/board/sprints"): scoped("task.read"),
    ("POST", "/api/board/sprints"): scoped("task.write"),
    ("POST", "/api/board/sprints/{sprint_id}/start"): scoped("task.write"),
    ("POST", "/api/board/sprints/{sprint_id}/complete"): scoped("task.write"),
    ("DELETE", "/api/board/sprints/{sprint_id}"): scoped("task.write"),
    ("GET", "/api/board/automations"): scoped("task.read"),
    ("POST", "/api/board/automations/rules"): scoped("task.write"),
    ("DELETE", "/api/board/automations/rules/{rule_id}"): scoped("task.write"),
    ("POST", "/api/board/automations/run"): scoped("task.write"),
    # Asking the board reads it: the question, its answer and its stop.
    ("POST", "/api/board/ask"): scoped("task.read"),
    ("GET", "/api/board/ask/jobs/{job_id}"): scoped("task.read"),
    ("POST", "/api/board/ask/jobs/{job_id}/cancel"): scoped("task.read"),
    ("GET", "/mcp"): Rule("personal_token"),
    ("POST", "/mcp"): Rule("personal_token"),
    ("DELETE", "/mcp"): Rule("personal_token"),
    # --- Shared features -------------------------------------------------------
    **{
        rule: value
        for feature in ("roadmap", "ideation", "context")
        for rule, value in (
            (("GET", f"/api/features/{feature}/snapshot"), scoped("insight.read")),
            (
                ("PUT", f"/api/features/{feature}/files/{{name}}"),
                scoped("insight.write"),
            ),
            (("POST", f"/api/features/{feature}/jobs"), scoped("agent.execute")),
            (
                ("GET", f"/api/features/{feature}/jobs/{{job_id}}"),
                scoped("insight.read"),
            ),
            (
                ("POST", f"/api/features/{feature}/jobs/{{job_id}}/cancel"),
                scoped("agent.cancel"),
            ),
        )
    },
    ("POST", "/api/features/roadmap/features/{feature_id}/convert"): scoped(
        "task.write"
    ),
    ("POST", "/api/features/ideation/ideas/{idea_id}/convert"): scoped("task.write"),
    ("GET", "/api/features/context/memories"): scoped("insight.read"),
    # The lifecycle of the project's memory: every member reads why a memory
    # went; a decision on it is a write of the project's insights.
    ("GET", "/api/features/context/memory/lifecycle"): scoped("insight.read"),
    ("GET", "/api/features/context/memory/history"): scoped("insight.read"),
    **{
        ("POST", f"/api/features/context/memory/{action}"): scoped("insight.write")
        for action in ("forget", "restore", "pin", "scope", "revert")
    },
    ("GET", "/api/features/insights/sessions"): scoped("insight.read"),
    ("POST", "/api/features/insights/sessions"): scoped("insight.write"),
    ("GET", "/api/features/insights/sessions/{session_id}"): scoped("insight.read"),
    ("PATCH", "/api/features/insights/sessions/{session_id}"): scoped("insight.write"),
    ("DELETE", "/api/features/insights/sessions/{session_id}"): scoped("insight.write"),
    ("POST", "/api/features/insights/sessions/{session_id}/messages"): scoped(
        "agent.execute"
    ),
    ("GET", "/api/features/insights/jobs/{job_id}"): scoped("insight.read"),
    ("POST", "/api/features/insights/jobs/{job_id}/cancel"): scoped("agent.cancel"),
    ("POST", "/api/features/forge/github/read"): scoped("vcs.read"),
    ("POST", "/api/features/forge/github/pulls"): scoped("vcs.read"),
    ("POST", "/api/features/forge/github/write"): scoped("vcs.write"),
    ("POST", "/api/features/forge/gitlab/read"): scoped("vcs.read"),
    ("POST", "/api/features/forge/gitlab/write"): scoped("vcs.write"),
    **{
        rule: value
        for forge in ("github", "gitlab")
        for rule, value in (
            (
                ("POST", f"/api/features/forge/{forge}/reviews/jobs"),
                scoped("agent.execute"),
            ),
            (
                ("GET", f"/api/features/forge/{forge}/reviews/jobs/{{job_id}}"),
                scoped("vcs.read"),
            ),
            (
                ("POST", f"/api/features/forge/{forge}/reviews/jobs/{{job_id}}/cancel"),
                scoped("agent.cancel"),
            ),
            (("GET", f"/api/features/forge/{forge}/reviews"), scoped("vcs.read")),
            (
                ("POST", f"/api/features/forge/{forge}/reviews/{{number}}/posted"),
                scoped("vcs.write"),
            ),
        )
    },
    # Feedback on a GitHub review's findings; resetting a rule and deciding a
    # held rejection are also the project owner's, checked in the route.
    ("GET", "/api/features/forge/github/reviews/{number}/feedback"): scoped("vcs.read"),
    ("POST", "/api/features/forge/github/reviews/{number}/feedback"): scoped(
        "vcs.write"
    ),
    ("GET", "/api/features/forge/github/reviews/feedback"): scoped("vcs.read"),
    ("POST", "/api/features/forge/github/reviews/feedback/reset"): scoped("vcs.write"),
    ("POST", "/api/features/forge/github/reviews/feedback/held"): scoped("vcs.write"),
    ("POST", "/api/features/analyses/{kind}/jobs"): scoped("agent.execute"),
    ("GET", "/api/features/analyses/{kind}/jobs/{job_id}"): scoped("insight.read"),
    ("POST", "/api/features/analyses/{kind}/jobs/{job_id}/cancel"): scoped(
        "agent.cancel"
    ),
    ("GET", "/api/features/analyses/{kind}/report"): scoped("insight.read"),
    ("GET", "/api/features/changelog/sources"): scoped("insight.read"),
    ("GET", "/api/features/changelog/commits"): scoped("insight.read"),
    ("PUT", "/api/features/changelog/report"): scoped("insight.write"),
    ("GET", "/api/features/workspace/sessions"): scoped("analytics.read"),
    ("GET", "/api/features/workspace/costs"): scoped("analytics.read"),
    ("GET", "/api/features/workspace/dashboard"): scoped("analytics.read"),
    ("GET", "/api/features/workspace/compare"): scoped("analytics.read"),
    ("POST", "/api/features/replay-shares"): scoped("lab.write"),
    ("GET", "/api/features/replay-shares"): scoped("lab.read"),
    ("POST", "/api/features/replay-shares/{share_id}/open"): scoped("lab.read"),
    ("DELETE", "/api/features/replay-shares/{share_id}"): scoped("lab.write"),
    # --- Team reviews of catalogue MCP servers (#369 lot 5) ---------------
    ("GET", "/api/features/mcp-reviews"): scoped("marketplace.read"),
    ("PUT", "/api/features/mcp-reviews"): scoped("marketplace.write"),
    ("DELETE", "/api/features/mcp-reviews/{review_id}"): scoped("marketplace.write"),
    ("GET", "/api/features/pixel-office/leaderboard"): scoped("analytics.read"),
    ("PUT", "/api/features/pixel-office/consent"): scoped("analytics.read"),
    ("GET", "/api/features/replay-shares/mine"): needs("lab.read"),
    ("GET", "/api/features/replay-shares/usage"): scoped("lab.read"),
    # Governance of a server project: reading is the audit domain, the rest
    # carries the permission of the act (approving, stopping, exporting).
    ("GET", "/api/features/governance"): scoped("audit.read"),
    ("GET", "/api/features/governance/audit"): scoped("audit.export"),
    ("POST", "/api/features/governance/approvals/{request_id}"): scoped(
        "review.approve"
    ),
    ("POST", "/api/features/governance/stop"): scoped("agent.cancel"),
    # Execution waves of a server project: reading the plan, the run and its
    # history is the board's read; starting the run and taking its steps start
    # agents; stopping it leaves running cards alone.
    ("GET", "/api/features/execution-waves/plan"): scoped("task.read"),
    ("GET", "/api/features/execution-waves/run"): scoped("task.read"),
    ("POST", "/api/features/execution-waves/run"): scoped("agent.execute"),
    ("POST", "/api/features/execution-waves/run/step"): scoped("agent.execute"),
    ("DELETE", "/api/features/execution-waves/run"): scoped("task.write"),
    ("GET", "/api/features/execution-waves/history"): scoped("task.read"),
}

#: Values for the path parameters: ids that exist nowhere, except the
#: project, which is the first organization's. Every check below is a
#: refusal, which comes before anything looks the id up.
_PLACEHOLDER = "00000000-0000-4000-8000-000000000000"


def served_routes(app) -> list[tuple[str, str]]:
    """Every (method, route) the app serves, through included routers."""
    found: list[tuple[str, str]] = []
    seen: set[int] = set()

    def visit(node) -> None:
        if id(node) in seen:
            return
        seen.add(id(node))
        for route in getattr(node, "routes", []):
            if isinstance(route, APIRoute):
                found.extend((method, route.path) for method in sorted(route.methods))
                continue
            inner = getattr(route, "original_router", None)
            if inner is not None:
                visit(inner)
            elif hasattr(route, "routes"):
                visit(route)

    visit(app.router)
    return found


def project_of(world: World, side: str) -> str:
    """The project of organization ``side``; ``none``: an id of no project."""
    return _PLACEHOLDER if side == "none" else world.projects[side]


def detail_of(answer) -> object:
    body = answer.json() if answer.content else None
    return body.get("detail") if isinstance(body, dict) else None


def url_for(world: World, path: str, side: str = "a") -> str:
    return re.sub(
        r"\{(\w+)\}",
        lambda m: (
            project_of(world, side) if m.group(1) == "project_id" else _PLACEHOLDER
        ),
        path,
    )


async def ask(
    world: World, who: str | None, method: str, path: str, side: str = "a", **kw
):
    rule = RULES[(method, path)]
    params = {"project_id": project_of(world, side)} if rule.scoped else None
    body = None if method in {"GET", "DELETE"} else {}
    return await world.call(
        who, method, url_for(world, path, side), params=params, json=body, **kw
    )


def _fails(answers: dict[str, str]) -> str:
    return "\n".join(f"{route}: {answer}" for route, answer in answers.items())


def _routes(*kinds: str, project_named: bool | None = None):
    for (method, path), rule in RULES.items():
        if rule.kind not in kinds:
            continue
        # An administration route that names a project acts on the
        # organization first (its group): tested with the groups.
        names_project = rule.scoped or (
            "{project_id}" in path and not path.startswith("/admin/")
        )
        if project_named is not None and names_project != project_named:
            continue
        yield method, path, rule


async def test_the_table_names_every_route_the_server_serves(world):
    served = served_routes(world.app)
    assert len(served) == len(set(served)), "a route is declared twice"
    unnamed = sorted(set(served) - set(RULES))
    stale = sorted(set(RULES) - set(served))
    assert not unnamed, (
        "Write down who may call these routes in RULES (and test what they do): "
        f"{unnamed}"
    )
    assert not stale, f"RULES names routes the server no longer serves: {stale}"


async def test_without_a_token_only_the_public_routes_answer(world):
    wrong = {}
    for (method, path), rule in RULES.items():
        answer = await ask(world, None, method, path)
        if rule.kind == "public":
            if answer.status_code == 401:
                wrong[f"{method} {path}"] = "public route asked for a token"
        elif answer.status_code != 401 or answer.json()["detail"] != (
            "Authentication required"
        ):
            wrong[f"{method} {path}"] = f"{answer.status_code} {answer.text[:80]}"
    assert not wrong, _fails(wrong)


async def test_a_token_the_server_did_not_sign_opens_nothing(world):
    """Same claims, another key: refused before any route, in one wording."""
    claims = pyjwt.decode(
        await world.token("owner_a"), options={"verify_signature": False}
    )
    forged = pyjwt.encode(claims, "an-attacker-key-" + "k" * 40, algorithm="HS256")
    wrong = {}
    for method, path, _ in _routes(
        "signed_in", "admin_role", "platform", "permission", "project"
    ):
        answer = await world.client.request(
            method,
            url_for(world, path),
            params={"project_id": world.projects["a"]},
            headers={"Authorization": f"Bearer {forged}"},
        )
        if (answer.status_code, answer.json().get("detail")) != (
            401,
            "Invalid or expired token",
        ):
            wrong[f"{method} {path}"] = f"{answer.status_code} {answer.text[:80]}"
    assert not wrong, _fails(wrong)


async def test_a_session_token_does_not_open_the_mcp_endpoint(world):
    """``/mcp`` takes a personal access token only (``server/auth/access_tokens.py``)."""
    for method, path, _ in _routes("personal_token"):
        answer = await ask(world, "owner_a", method, path)
        assert answer.status_code == 401, (method, answer.text)
        assert answer.json()["detail"] == "Invalid, revoked or expired token"


async def test_every_permission_is_asked_by_name(world):
    """A member of the project whose role grants nothing gets each route's
    own permission back: proof the route carries that one, not another."""
    wrong = {}
    for method, path, rule in _routes("permission"):
        answer = await ask(world, "nobody_a", method, path)
        expected = (403, f"Missing permission: {rule.permission}")
        got = (answer.status_code, detail_of(answer))
        if got != expected:
            wrong[f"{method} {path}"] = f"{got} instead of {expected}"
    assert not wrong, _fails(wrong)


async def test_a_project_route_takes_the_organization_s_read_permission(world):
    """A role on the project opens it within what the organization grants: a
    member whose organization role grants nothing reads none of it."""
    wrong = {}
    for method, path, _ in _routes("project"):
        answer = await ask(world, "nobody_a", method, path)
        expected = (403, "Missing permission: task.read")
        got = (answer.status_code, detail_of(answer))
        if got != expected:
            wrong[f"{method} {path}"] = f"{got} instead of {expected}"
    assert not wrong, _fails(wrong)


async def test_a_permission_comes_from_the_role_not_from_the_project(world):
    """A viewer of the project holds the reads and none of the writes."""
    from server.authz.roles import system_role

    viewer = system_role("viewer").permissions
    wrong = {}
    for method, path, rule in _routes("permission"):
        if rule.permission in viewer:
            continue
        answer = await ask(world, "viewer_a", method, path)
        if answer.status_code != 403:
            wrong[f"{method} {path}"] = f"{answer.status_code} {answer.text[:80]}"
    assert not wrong, _fails(wrong)


async def test_the_platform_routes_refuse_an_organization_administrator(world):
    for method, path, _ in _routes("platform"):
        answer = await ask(world, "owner_a", method, path)
        assert answer.status_code == 403, (method, path, answer.text)
        assert answer.json()["detail"] == "Platform administrator required"
    for method, path, _ in _routes("admin_role"):
        answer = await ask(world, "owner_a", method, path)
        assert answer.status_code == 403, (method, path, answer.text)
        assert answer.json()["detail"] == "Admin role required"


async def test_another_organization_cannot_tell_the_project_exists(world):
    """Its people get, on every route that names the first organization's
    project, exactly what they get for a project that does not exist: 404 for
    its administrator, who holds every permission of their own tenant, never
    a 403 that would confirm the id; for its member, a refusal of a permission
    they lack is the same on both, since it comes before any project."""
    wrong = {}
    for method, path, rule in _routes("permission", "project", project_named=True):
        for who in ("admin_b", "member_b"):
            real = await ask(world, who, method, path)
            unknown = await ask(world, who, method, path, side="none")
            got = (real.status_code, detail_of(real))
            if got != (unknown.status_code, detail_of(unknown)):
                wrong[f"{method} {path} as {who}"] = f"{got} vs {detail_of(unknown)}"
            elif who == "admin_b" and got != (404, "Project not found"):
                wrong[f"{method} {path} as {who}"] = str(got)
    assert not wrong, _fails(wrong)


async def test_an_unknown_project_is_not_found(world):
    wrong = {}
    for method, path, _ in _routes("permission", "project", project_named=True):
        answer = await ask(world, "owner_a", method, path, side="none")
        got = (answer.status_code, detail_of(answer))
        if got != (404, "Project not found"):
            wrong[f"{method} {path}"] = str(got)
    assert not wrong, _fails(wrong)


async def test_a_person_of_the_organization_off_the_project_is_refused(world):
    """``stranger_a`` holds contributor rights in the organization and no role
    on the project: refused, and told so (the project is of their tenant)."""
    wrong = {}
    for method, path, rule in _routes("permission", "project", project_named=True):
        answer = await ask(world, "stranger_a", method, path)
        detail = detail_of(answer)
        if answer.status_code != 403 or detail not in {
            "Not a member of this project",
            f"Missing permission: {rule.permission}",
        }:
            wrong[f"{method} {path}"] = f"{answer.status_code} {detail}"
    assert not wrong, _fails(wrong)


async def test_a_role_below_the_route_s_is_refused(world):
    """A viewer of the project cannot act as its member, a member as its owner."""
    below = {"member": "viewer_a", "owner": "contributor_a"}
    for method, path, rule in _routes("project"):
        if rule.project_role not in below:
            continue
        answer = await ask(world, below[rule.project_role], method, path)
        assert answer.status_code == 403, (method, path, answer.text)
        assert answer.json()["detail"] == (
            f"Requires project role '{rule.project_role}' or higher"
        )


async def test_an_organization_administrator_reaches_every_project_of_it(world):
    """``admin_a`` administers the organization and is on none of its projects:
    the project list gives them each one as its owner, and so does every route
    that names one (as the project scope of the shared features does). Reads
    only: a write that passes would start jobs or delete the project."""
    listed = await world.ok("admin_a", "GET", "/projects")
    assert {p["id"]: p["my_role"] for p in listed} == {world.projects["a"]: "owner"}
    wrong = {}
    for method, path, _ in _routes("permission", "project", project_named=True):
        if method != "GET":
            continue
        answer = await ask(world, "admin_a", method, path)
        detail = detail_of(answer)
        if answer.status_code in {401, 403} or detail == "Project not found":
            wrong[f"{method} {path}"] = f"{answer.status_code} {detail}"
    assert not wrong, _fails(wrong)


async def test_a_group_gives_its_members_the_project(world):
    """``grouped_a`` is a viewer of the organization and on no project; their
    group gives them contributor rights and the project as a member. Reads
    only, as above. A read whose permission a contributor does not hold (an
    export of the audit trail) is refused for that permission, and only it."""
    held = system_role("contributor").permissions
    wrong = {}
    for method, path, rule in _routes("permission", "project", project_named=True):
        if method != "GET":
            continue
        answer = await ask(world, "grouped_a", method, path)
        detail = detail_of(answer)
        if rule.permission and rule.permission not in held:
            if (answer.status_code, detail) != (
                403,
                f"Missing permission: {rule.permission}",
            ):
                wrong[f"{method} {path}"] = f"{answer.status_code} {detail}"
        elif answer.status_code in {401, 403} or detail == "Project not found":
            wrong[f"{method} {path}"] = f"{answer.status_code} {detail}"
    assert not wrong, _fails(wrong)

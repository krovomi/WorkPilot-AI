"""Every feature router in ``provider_api`` must be mounted with a permission.

These checks are deliberately *static*: they read the source rather than the
built app. The feature routers are mounted inside ``try/except ImportError``, so
on a machine missing an optional dependency the router silently disappears and a
runtime assertion would pass while proving nothing. Reading the source catches a
new router added without a guard even when that router cannot be imported here.
"""

from __future__ import annotations

import ast
import re
import sys
from pathlib import Path

_REPO = Path(__file__).resolve().parents[2]
_BACKEND = _REPO / "apps" / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from server.authz.catalog import FEATURE_DOMAINS, PERMISSIONS  # noqa: E402

_PROVIDER_API = _BACKEND / "provider_api.py"
_SOURCE = _PROVIDER_API.read_text(encoding="utf-8")


def _mount_calls() -> list[tuple[str, str]]:
    """Every ``_mount(router, "feature")`` in provider_api, as (var, feature)."""
    tree = ast.parse(_SOURCE)
    calls = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        if not (isinstance(node.func, ast.Name) and node.func.id == "_mount"):
            continue
        if len(node.args) != 2:
            continue
        router, feature = node.args
        if isinstance(router, ast.Name) and isinstance(feature, ast.Constant):
            calls.append((router.id, feature.value))
    return calls


class TestEveryRouterIsGuarded:
    def test_no_router_bypasses_the_mount_helper(self):
        """A raw ``app.include_router`` outside the helper is an unguarded surface."""
        raw = [
            (i, line.strip())
            for i, line in enumerate(_SOURCE.splitlines(), start=1)
            if re.search(r"\bapp\.include_router\(", line)
        ]
        # The single legitimate one is inside `_mount` itself, on the local-mode
        # branch where there is nothing to guard.
        assert len(raw) == 1, (
            "Feature routers must be mounted through `_mount(router, feature)` so "
            "they carry a permission in server mode. Found raw include_router at: "
            + "; ".join(f"line {n}: {t}" for n, t in raw)
        )

    def test_all_thirty_four_routers_are_mounted_through_the_helper(self):
        calls = _mount_calls()
        assert len(calls) >= 34, (
            f"expected at least 34 guarded mounts, got {len(calls)}"
        )

    def test_every_mounted_feature_is_in_the_catalog(self):
        """An unmapped feature raises at boot; catch it here instead."""
        unknown = sorted(
            {feature for _, feature in _mount_calls() if feature not in FEATURE_DOMAINS}
        )
        assert not unknown, (
            "These features are mounted but absent from catalog.FEATURE_DOMAINS, "
            f"which makes provider_api raise on startup in server mode: {unknown}"
        )

    def test_every_mapped_domain_can_be_derived(self):
        """`<domain>.read` and `<domain>.write` must both exist for derivation."""
        missing = []
        for _, feature in _mount_calls():
            domain = FEATURE_DOMAINS.get(feature)
            if domain is None:
                continue
            for action in ("read", "write"):
                if f"{domain}.{action}" not in PERMISSIONS:
                    missing.append(f"{feature} -> {domain}.{action}")
        assert not missing, f"undeclared permissions: {sorted(set(missing))}"

    def test_router_variable_names_are_not_reused_for_different_features(self):
        """Two features sharing a variable means one of them is mounted wrong.

        ``analytics_router`` is the deliberate exception: provider_api mounts a
        real implementation and falls back to a minimal stub under the same name.
        """
        by_var: dict[str, set[str]] = {}
        for var, feature in _mount_calls():
            by_var.setdefault(var, set()).add(feature)
        conflicts = {v: f for v, f in by_var.items() if len(f) > 1}
        assert not conflicts, f"variables mapped to several features: {conflicts}"


class TestDangerousRoutesAreRaisedAboveTheirVerb:
    def test_agent_executing_routes_require_agent_execute(self):
        """A POST that runs a tooled agent must not settle for ``<domain>.write``."""
        from server.authz.mounting import ROUTE_OVERRIDES, permission_for

        assert (
            permission_for("POST", "/api/slash-commands/run", "agent")
            == "agent.execute"
        )
        executing = {
            path
            for (method, path), key in ROUTE_OVERRIDES.items()
            if key in {"agent.execute", "ops.execute"}
        }
        assert "/api/slash-commands/run" in executing
        assert "/api/code-playground/run" in executing

    def test_audit_exports_require_the_export_permission(self):
        from server.authz.mounting import permission_for

        # Plain reads of the trail stay `audit.read`; the exports carry personal
        # data and are held to a separate grant.
        assert permission_for("GET", "/api/audit-trail/events", "audit") == "audit.read"
        assert (
            permission_for("GET", "/api/audit-trail/export/gdpr", "audit")
            == "audit.export"
        )

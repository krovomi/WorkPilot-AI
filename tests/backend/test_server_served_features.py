"""A server serves only what an organization's projects own.

Every feature router of ``provider_api`` is classified once, in
``server.authz.catalog``: ``SERVER_FEATURES`` (a project addressed by its
``project_id`` through the server's database) or ``LOCAL_ONLY_FEATURES`` (the
desktop app's machine-local tools). In server mode ``_mount`` mounts the first
set and leaves the second to the local backend, so its routes answer 404.

The classification is checked statically, from the source, like
``test_feature_router_authz.py``: a router dropped at import for a missing
optional dependency must not let an unclassified feature pass. The mounting is
then checked on the real routers, replayed through ``provider_api._mount`` with
server mode on.
"""

from __future__ import annotations

import ast
import sys
from pathlib import Path

import pytest
from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient

_REPO = Path(__file__).resolve().parents[2]
_BACKEND = _REPO / "apps" / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from server.authz import catalog  # noqa: E402
from server.authz.principal import Principal  # noqa: E402

_SOURCE = (_BACKEND / "provider_api.py").read_text(encoding="utf-8")


def _mount_calls() -> list[tuple[str, str]]:
    """Every ``_mount(router, "feature")`` in provider_api, in order, once."""
    calls: list[tuple[str, str]] = []
    for node in ast.walk(ast.parse(_SOURCE)):
        if not (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id == "_mount"
            and len(node.args) == 2
        ):
            continue
        router, feature = node.args
        if isinstance(router, ast.Name) and isinstance(feature, ast.Constant):
            if (router.id, feature.value) not in calls:
                calls.append((router.id, feature.value))
    return calls


def _shared_mounts() -> list[tuple[APIRouter, str]]:
    """What ``shared_features.mount_all`` hands to ``_mount``."""
    from shared_features import mount_all

    mounts: list[tuple[APIRouter, str]] = []
    mount_all(lambda router, feature: mounts.append((router, feature)))
    return mounts


def walk_api_routes(router) -> list:
    """Every ``APIRoute`` reachable from `router`, through included routers
    (the walker of ``test_project_scope_coverage.py``)."""
    from fastapi.routing import APIRoute

    found: list = []
    seen: set[int] = set()

    def visit(node) -> None:
        if id(node) in seen:
            return
        seen.add(id(node))
        for route in getattr(node, "routes", []):
            if isinstance(route, APIRoute):
                found.append(route)
                continue
            inner = getattr(route, "original_router", None)
            if inner is not None:
                visit(inner)
            elif hasattr(route, "routes"):
                visit(route)

    visit(router)
    return found


def _signatures(router) -> set[tuple[str, frozenset[str]]]:
    return {(r.path, frozenset(r.methods)) for r in walk_api_routes(router)}


class TestEveryFeatureChoosesWhereItIsServed:
    def test_the_two_sets_are_disjoint(self):
        both = catalog.SERVER_FEATURES & catalog.LOCAL_ONLY_FEATURES
        assert not both, f"features both served and local-only: {sorted(both)}"

    def test_every_feature_of_the_catalog_is_classified(self):
        classified = catalog.SERVER_FEATURES | catalog.LOCAL_ONLY_FEATURES
        unclassified = sorted(set(catalog.FEATURE_DOMAINS) - classified)
        unknown = sorted(classified - set(catalog.FEATURE_DOMAINS))
        assert not unclassified, (
            "Add these features to catalog.SERVER_FEATURES (a project addressed "
            "by its project_id through the server's database) or to "
            f"catalog.LOCAL_ONLY_FEATURES (a machine-local tool): {unclassified}"
        )
        assert not unknown, f"classified but not in FEATURE_DOMAINS: {unknown}"

    def test_every_mounted_router_is_classified(self):
        features = {feature for _, feature in _mount_calls()}
        features |= {feature for _, feature in _shared_mounts()}
        classified = catalog.SERVER_FEATURES | catalog.LOCAL_ONLY_FEATURES
        assert features, "no mount found in provider_api"
        assert not sorted(features - classified), sorted(features - classified)

    def test_the_shared_project_features_are_the_ones_served(self):
        """Board and shared features, all addressed by project_id."""
        shared = {feature for _, feature in _shared_mounts()}
        assert shared == set(catalog.SERVER_FEATURES)

    def test_the_desktop_routers_are_local_only(self):
        legacy = {feature for _, feature in _mount_calls()}
        assert legacy <= catalog.LOCAL_ONLY_FEATURES, sorted(
            legacy - catalog.LOCAL_ONLY_FEATURES
        )


@pytest.fixture
def server_app(monkeypatch, tmp_path):
    """Every router of provider_api replayed through ``_mount`` in server mode.

    The requests carry a platform administrator, who passes every permission
    guard: a route that answers 404 here is absent, not refused.
    """
    try:
        import provider_api
    except Exception as exc:  # pragma: no cover - dependency-dependent
        pytest.skip(f"provider_api could not be imported: {exc}")
        raise

    monkeypatch.setenv("WORKPILOT_DATA_DIR", str(tmp_path / "data"))
    app = FastAPI()
    admin = Principal(id="admin", platform_role="admin", org_id="org-1")

    @app.middleware("http")
    async def _principal(request, call_next):
        request.state.principal = admin
        return await call_next(request)

    monkeypatch.setattr(provider_api, "app", app)
    monkeypatch.setattr(provider_api, "_SERVER_MODE_ACTIVE", True)

    routers: dict[str, list[APIRouter]] = {}
    for var, feature in _mount_calls():
        router = getattr(provider_api, var, None)
        if router is None:  # pragma: no cover - optional dependency missing
            continue
        routers.setdefault(feature, []).append(router)
        provider_api._mount(router, feature)
    for router, feature in _shared_mounts():
        routers.setdefault(feature, []).append(router)
        provider_api._mount(router, feature)
    return app, routers


class TestAServerMountsOnlyProjectFeatures:
    def test_the_desktop_hooks_are_not_served_by_a_server(self, server_app):
        app, _ = server_app
        with TestClient(app) as client:
            for method, path in (
                ("GET", "/api/hooks"),
                ("GET", "/api/hooks/stats"),
                ("GET", "/api/hooks/templates"),
                ("GET", "/api/hooks/executions/history"),
                ("POST", "/api/hooks"),
                ("POST", "/api/hooks/emit"),
                ("PUT", "/api/hooks/h-1"),
                ("DELETE", "/api/hooks/h-1"),
            ):
                answer = client.request(method, path, json={})
                assert answer.status_code == 404, f"{method} {path}"

    def test_machine_wide_ledgers_are_not_served_by_a_server(self, server_app):
        app, _ = server_app
        with TestClient(app) as client:
            for path in (
                "/api/costs/summary/p-1",
                "/api/costs/budget/p-1",
                "/api/feedback/stats/p-1",
                "/api/dashboard/stats",
                "/providers",
            ):
                assert client.get(path).status_code == 404, path

    def test_no_route_of_a_local_only_feature_is_mounted(self, server_app):
        app, routers = server_app
        mounted = _signatures(app.router)
        leaked = {}
        for feature, feature_routers in routers.items():
            if feature in catalog.SERVER_FEATURES:
                continue
            for router in feature_routers:
                present = _signatures(router) & mounted
                if present:
                    leaked[feature] = sorted(path for path, _ in present)
        assert not leaked, f"local-only routes mounted on a server: {leaked}"

    def test_every_route_of_a_served_feature_is_mounted(self, server_app):
        app, routers = server_app
        mounted = _signatures(app.router)
        assert set(catalog.SERVER_FEATURES) <= set(routers)
        for feature in catalog.SERVER_FEATURES:
            for router in routers[feature]:
                missing = _signatures(router) - mounted
                assert not missing, f"{feature}: {sorted(p for p, _ in missing)}"

    def test_a_representative_of_each_served_family_answers(self, server_app):
        app, _ = server_app
        paths = {r.path for r in walk_api_routes(app.router)}
        for path in (
            "/api/board/snapshot",
            "/api/board/cards",
            "/api/features/roadmap/snapshot",
            "/api/features/ideation/snapshot",
            "/api/features/context/snapshot",
            "/api/features/insights/sessions",
            "/api/features/forge/github/read",
            "/api/features/analyses/{kind}/report",
            "/api/features/workspace/costs",
        ):
            assert path in paths, path
        with TestClient(app) as client:
            assert client.get("/api/board/stream").status_code == 200

    def test_local_mode_still_mounts_every_router(self, monkeypatch, server_app):
        """The desktop app's backend keeps all of them."""
        import provider_api

        _, routers = server_app
        app = FastAPI()
        monkeypatch.setattr(provider_api, "app", app)
        monkeypatch.setattr(provider_api, "_SERVER_MODE_ACTIVE", False)
        for feature, feature_routers in routers.items():
            for router in feature_routers:
                provider_api._mount(router, feature)
        mounted = _signatures(app.router)
        for feature_routers in routers.values():
            for router in feature_routers:
                assert _signatures(router) <= mounted


class TestMountServed:
    def test_an_unknown_feature_still_fails_loudly(self):
        from server.authz.mounting import mount_served

        with pytest.raises(KeyError, match="Unknown feature"):
            mount_served(FastAPI(), APIRouter(), "nope")

    def test_a_local_only_feature_is_left_out(self):
        from server.authz.mounting import mount_served

        router = APIRouter()

        @router.get("/api/hooks")
        def hooks():  # pragma: no cover - never mounted
            return {}

        app = FastAPI()
        assert mount_served(app, router, "event_hooks") is False
        assert not walk_api_routes(app.router)


class TestTheHookSchedulerStaysLocal:
    def test_a_server_does_not_run_scheduled_hooks(self, monkeypatch):
        from services.hooks import scheduler

        monkeypatch.setattr(
            "foundation.api_safety.server_mode_roots", lambda: [Path("/srv/repos")]
        )
        monkeypatch.setattr(scheduler, "_scheduler", None)
        assert scheduler.start_hook_scheduler() is None
        assert scheduler._scheduler is None

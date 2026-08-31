"""``mount_guarded`` must actually gate every route of a mounted router.

The whole authorization design rests on one FastAPI behaviour: dependencies
passed to ``include_router`` apply to every path operation in that router. If
that ever stopped holding, ~150 legacy endpoints would silently lose their
guard while every other test kept passing — so it is pinned here directly,
including for the seven routers that declare absolute paths with no ``prefix=``
(``dashboard``, ``slash_commands``, ``system_status``…), which is the shape a
policy table keyed on ``router.prefix`` would have missed.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi import APIRouter, Depends, FastAPI
from fastapi.testclient import TestClient

_BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from server.authz import mounting  # noqa: E402
from server.authz.principal import Principal  # noqa: E402


def _app_with(principal: Principal, *mounts) -> FastAPI:
    """An app whose requests carry `principal`, with `mounts` guarded."""
    app = FastAPI()

    @app.middleware("http")
    async def _inject(request, call_next):
        request.state.principal = principal
        return await call_next(request)

    for router, feature in mounts:
        mounting.mount_guarded(app, router, feature)
    return app


def _absolute_path_router() -> APIRouter:
    """A router in the shape of dashboard/api.py: no prefix, absolute paths."""
    router = APIRouter()

    @router.get("/api/dashboard/stats")
    def stats():
        return {"ok": True}

    @router.post("/api/dashboard/export")
    def export():
        return {"ok": True}

    return router


def _prefixed_router() -> APIRouter:
    router = APIRouter(prefix="/api/timeline")

    @router.get("/{correlation_id}")
    def timeline(correlation_id: str):
        return {"ok": True}

    return router


def _principal(*permissions: str) -> Principal:
    return Principal(
        id="u1",
        email="u@example.com",
        platform_role="member",
        org_id="org1",
        permissions=frozenset(permissions),
    )


class TestPermissionDerivation:
    def test_read_methods_map_to_read(self):
        for method in ("GET", "HEAD", "OPTIONS"):
            assert (
                mounting.permission_for(method, "/api/x", "analytics")
                == "analytics.read"
            )

    def test_write_methods_map_to_write(self):
        for method in ("POST", "PUT", "PATCH", "DELETE"):
            assert (
                mounting.permission_for(method, "/api/x", "analytics")
                == "analytics.write"
            )

    def test_override_wins_over_derivation(self):
        assert (
            mounting.permission_for("POST", "/api/slash-commands/run", "agent")
            == "agent.execute"
        )

    def test_every_override_names_a_real_permission(self):
        from server.authz.catalog import PERMISSIONS

        for (method, path), key in mounting.ROUTE_OVERRIDES.items():
            assert key in PERMISSIONS, f"{method} {path} -> unknown permission {key}"


class TestGuardAppliesToWholeRouter:
    def test_absolute_path_router_is_guarded(self):
        """The shape a prefix-keyed policy table would have missed."""
        app = _app_with(_principal(), (_absolute_path_router(), "dashboard"))
        with TestClient(app) as client:
            assert client.get("/api/dashboard/stats").status_code == 403
            assert client.post("/api/dashboard/export").status_code == 403

    def test_prefixed_router_is_guarded(self):
        app = _app_with(_principal(), (_prefixed_router(), "timeline"))
        with TestClient(app) as client:
            assert client.get("/api/timeline/abc").status_code == 403

    def test_read_permission_opens_get_but_not_post(self):
        app = _app_with(
            _principal("analytics.read"), (_absolute_path_router(), "dashboard")
        )
        with TestClient(app) as client:
            assert client.get("/api/dashboard/stats").status_code == 200
            resp = client.post("/api/dashboard/export")
            assert resp.status_code == 403
            assert "analytics.write" in resp.json()["detail"]

    def test_write_permission_opens_post(self):
        app = _app_with(
            _principal("analytics.read", "analytics.write"),
            (_absolute_path_router(), "dashboard"),
        )
        with TestClient(app) as client:
            assert client.post("/api/dashboard/export").status_code == 200

    def test_guard_composes_with_the_routers_own_dependencies(self):
        """Legacy routers already use Depends; the guard must not displace them."""
        seen = []

        def own_dep():
            seen.append("own")
            return "own"

        router = APIRouter(prefix="/api/qa")

        @router.get("/score")
        def score(marker=Depends(own_dep)):
            return {"marker": marker}

        app = _app_with(_principal("qa.read"), (router, "qa_promotion"))
        with TestClient(app) as client:
            resp = client.get("/api/qa/score")
            assert resp.status_code == 200
            assert resp.json() == {"marker": "own"}
            assert seen == ["own"]


class TestOverridesAreEnforced:
    def test_slash_command_run_needs_agent_execute_not_agent_write(self):
        """`agent.write` must not be enough to execute a tooled agent session."""
        router = APIRouter()

        @router.post("/api/slash-commands/run")
        def run():
            return {"ok": True}

        app = _app_with(
            _principal("agent.read", "agent.write"), (router, "slash_commands")
        )
        with TestClient(app) as client:
            resp = client.post("/api/slash-commands/run")
            assert resp.status_code == 403
            assert "agent.execute" in resp.json()["detail"]

        app = _app_with(_principal("agent.execute"), (router, "slash_commands"))
        with TestClient(app) as client:
            assert client.post("/api/slash-commands/run").status_code == 200


class TestPrincipalShortcuts:
    def test_platform_admin_passes_every_guard(self):
        admin = Principal(id="a", platform_role="admin", org_id="org1")
        app = _app_with(admin, (_absolute_path_router(), "dashboard"))
        with TestClient(app) as client:
            assert client.get("/api/dashboard/stats").status_code == 200
            assert client.post("/api/dashboard/export").status_code == 200

    def test_local_principal_passes_every_guard(self):
        from server.authz.principal import LOCAL_PRINCIPAL

        app = _app_with(LOCAL_PRINCIPAL, (_absolute_path_router(), "dashboard"))
        with TestClient(app) as client:
            assert client.get("/api/dashboard/stats").status_code == 200
            assert client.post("/api/dashboard/export").status_code == 200


class TestMountingContract:
    def test_disabled_mount_adds_no_guard(self):
        """Local mode pays nothing for a check that would always pass."""
        app = FastAPI()
        mounting.mount_guarded(app, _absolute_path_router(), "dashboard", enabled=False)
        with TestClient(app) as client:
            assert client.get("/api/dashboard/stats").status_code == 200

    def test_unknown_feature_fails_loudly_at_mount_time(self):
        app = FastAPI()
        with pytest.raises(KeyError, match="Unknown feature"):
            mounting.mount_guarded(app, _absolute_path_router(), "nope")

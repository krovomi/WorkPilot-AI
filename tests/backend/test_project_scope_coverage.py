"""No route may take a filesystem path from the client in server mode.

This is the central security test of multi-tenancy. The legacy API let a caller
pass ``project_dir`` — an absolute path — and read or write it; on a shared
server that is a cross-tenant read/write, and ``POST /api/slash-commands/run``
turns it into arbitrary agent execution rooted anywhere on the host.

Two barriers close it, and both are checked here:

* the auth middleware refuses any request carrying such a parameter in the
  query string, so the failure is loud rather than silent;
* ``core.api_safety.validated_dir`` imposes ``REPOS_ROOT`` when no allowed root
  is given, which also covers the endpoints that read the path out of a JSON
  body, where the middleware never sees it.

The last test walks the real application's routes. It is the one that keeps
this true: an endpoint added next year with a ``project_dir`` parameter fails
here rather than shipping a hole.
"""

from __future__ import annotations

import inspect
import sys
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[2]
_BACKEND = _REPO / "apps" / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from server import config as server_config  # noqa: E402

_VALID_SECRET = "x" * 48


@pytest.fixture(autouse=True)
def _clean_settings(monkeypatch, tmp_path):
    for key in list(server_config.os.environ):
        if key.startswith("WORKPILOT_"):
            monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv(
        "WORKPILOT_DATABASE_URL",
        "sqlite+aiosqlite:///" + str(tmp_path / "scope.sqlite3").replace("\\", "/"),
    )
    server_config.reset_settings_cache()
    yield
    server_config.reset_settings_cache()


def _enable_server_mode(monkeypatch, repos_root: Path) -> None:
    monkeypatch.setenv("WORKPILOT_SERVER_MODE", "1")
    monkeypatch.setenv("WORKPILOT_JWT_SECRET", _VALID_SECRET)
    monkeypatch.setenv("WORKPILOT_REPOS_ROOT", str(repos_root))
    server_config.reset_settings_cache()


class TestValidatedDirConfinement:
    """The chokepoint every path-taking endpoint already funnels through."""

    def test_local_mode_still_accepts_any_directory(self, monkeypatch, tmp_path):
        """The desktop app must lose nothing: there is no boundary to draw."""
        monkeypatch.setenv("WORKPILOT_SERVER_MODE", "0")
        server_config.reset_settings_cache()
        from core.api_safety import validated_dir

        somewhere = tmp_path / "anywhere"
        somewhere.mkdir()
        assert validated_dir(str(somewhere), "project_dir") == somewhere.resolve()

    def test_server_mode_confines_to_repos_root(self, monkeypatch, tmp_path):
        repos_root = tmp_path / "repos"
        (repos_root / "proj-a").mkdir(parents=True)
        _enable_server_mode(monkeypatch, repos_root)

        from core.api_safety import validated_dir

        inside = repos_root / "proj-a"
        assert validated_dir(str(inside), "project_dir") == inside.resolve()

    def test_server_mode_refuses_a_path_outside_repos_root(self, monkeypatch, tmp_path):
        """The cross-tenant read this whole change exists to prevent."""
        repos_root = tmp_path / "repos"
        repos_root.mkdir()
        outside = tmp_path / "etc"
        outside.mkdir()
        _enable_server_mode(monkeypatch, repos_root)

        from core.api_safety import validated_dir

        with pytest.raises(ValueError, match="outside every allowed root"):
            validated_dir(str(outside), "project_dir")

    def test_an_explicit_allowed_root_still_wins(self, monkeypatch, tmp_path):
        """A caller that genuinely needs another root says so."""
        repos_root = tmp_path / "repos"
        repos_root.mkdir()
        other = tmp_path / "other"
        other.mkdir()
        _enable_server_mode(monkeypatch, repos_root)

        from core.api_safety import validated_dir

        assert (
            validated_dir(str(other), "d", allowed_roots=[other]) == other.resolve()
        )

    def test_traversal_is_still_refused(self, monkeypatch, tmp_path):
        repos_root = tmp_path / "repos"
        repos_root.mkdir()
        _enable_server_mode(monkeypatch, repos_root)

        from core.api_safety import validated_dir

        with pytest.raises(ValueError, match="must not contain"):
            validated_dir(str(repos_root / ".." / "etc"), "project_dir")


class TestMiddlewareRejectsClientSuppliedPaths:
    def test_query_string_path_parameter_is_refused(self, monkeypatch, tmp_path):
        _enable_server_mode(monkeypatch, tmp_path / "repos")

        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from server.integration import mount_server_mode

        app = FastAPI()

        @app.get("/api/timeline/{cid}")
        def _legacy(cid: str, project_dir: str = ""):  # pragma: no cover
            return {"cid": cid}

        assert mount_server_mode(app) is True

        with TestClient(app) as client:
            # Unauthenticated first: the 401 must still come first.
            assert client.get("/api/timeline/x?project_dir=/etc").status_code == 401

    def test_every_known_alias_is_listed(self):
        """The camelCase spellings matter: the Electron client uses them."""
        from server.integration import CLIENT_PATH_PARAMS

        for name in ("project_dir", "projectDir", "spec_dir", "project_path", "cwd"):
            assert name in CLIENT_PATH_PARAMS


def walk_api_routes(router) -> list:
    """Every ``APIRoute`` reachable from `router`, following lazy inclusions.

    FastAPI does not flatten ``include_router`` into ``app.routes`` any more: an
    included router shows up as a single ``_IncludedRouter`` wrapping the
    original. A sweep that only filtered ``app.routes`` for ``APIRoute`` saw 19
    routes on an app that actually serves 156 — and would have reported a clean
    bill of health for every endpoint it never looked at.
    """
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


class TestRouteCoverage:
    """Walk the real app and refuse any unguarded path parameter."""

    # provider_api mounts every feature router inside try/except, so a missing
    # optional dependency drops the router silently and this test would sweep
    # an almost-empty app and pass. Below this many routes it is not testing
    # anything, and saying so is worth more than a green tick.
    MIN_MEANINGFUL_ROUTES = 60

    @staticmethod
    def _load_app():
        try:
            from provider_api import app
        except Exception as exc:  # pragma: no cover - dependency-dependent
            pytest.skip(f"provider_api could not be imported: {exc}")
        return app

    def _routes(self):
        app = self._load_app()
        routes = walk_api_routes(app.router)
        if len(routes) < self.MIN_MEANINGFUL_ROUTES:
            pytest.skip(
                f"Only {len(routes)} routes mounted (expected at least "
                f"{self.MIN_MEANINGFUL_ROUTES}). The feature routers are dropped "
                "when their optional dependencies are missing, so this sweep "
                "would prove nothing. Install the backend requirements."
            )
        return routes

    def test_the_walker_sees_more_than_the_top_level_routes(self):
        """Guards the walker itself against FastAPI's lazy inclusion."""
        from fastapi.routing import APIRoute

        app = self._load_app()
        naive = [r for r in app.routes if isinstance(r, APIRoute)]
        walked = walk_api_routes(app.router)
        assert len(walked) > len(naive), (
            "The route walker is not following included routers; the sweep "
            "below would silently skip every mounted feature router."
        )

    def test_the_sweep_actually_covers_the_feature_routers(self):
        """Guards the guard: prove the app under test is the real one."""
        routes = self._routes()
        prefixes = {r.path.split("/")[1] for r in routes if "/" in r.path}
        assert "api" in prefixes, "the /api feature routers are not mounted"

    def test_no_route_declares_an_unprotected_path_parameter(self, monkeypatch, tmp_path):
        """Every ``project_dir``-style parameter must be covered.

        A parameter is acceptable when the middleware would refuse it in the
        query string (it is in ``CLIENT_PATH_PARAMS``). Anything else is a path
        the client can name and the server does not police, which is exactly
        the shape of the vulnerability being closed.
        """
        _enable_server_mode(monkeypatch, tmp_path / "repos")

        from server.integration import CLIENT_PATH_PARAMS

        suspicious = []
        for route in self._routes():
            try:
                signature = inspect.signature(route.endpoint)
            except (TypeError, ValueError):  # pragma: no cover
                continue
            for name in signature.parameters:
                lowered = name.lower()
                if "dir" not in lowered and "path" not in lowered:
                    continue
                if name in CLIENT_PATH_PARAMS:
                    continue  # refused by the middleware
                if name in route.path_format:
                    continue  # part of the URL template, not a filesystem path
                suspicious.append(f"{sorted(route.methods)} {route.path} :: {name}")

        assert not suspicious, (
            "These routes take a path-like parameter that the middleware does "
            "not refuse. Either add the parameter name to "
            "server.integration.CLIENT_PATH_PARAMS, or take a project_id and "
            "use server.authz.scope.resolve_project_scope:\n  "
            + "\n  ".join(sorted(suspicious))
        )

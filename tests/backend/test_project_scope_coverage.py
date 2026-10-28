"""No route may take a filesystem path from the client in server mode.

This is the central security test of multi-tenancy. The legacy API let a caller
pass ``project_dir`` — an absolute path — and read or write it; on a shared
server that is a cross-tenant read/write, and ``POST /api/slash-commands/run``
turns it into arbitrary agent execution rooted anywhere on the host.

Two barriers close it, and both are checked here:

* the auth middleware refuses any request carrying such a key in the query
  string or anywhere in its body (JSON or form), so the failure is loud rather
  than silent. The body used to go unread, and about forty routes take
  ``project_dir``, ``spec_dir`` or ``file_path`` there — one of them,
  ``/api/slash-commands/run``, as a bare ``dict`` no signature shows;
* ``foundation.api_safety.validated_dir`` imposes ``REPOS_ROOT`` when no allowed root
  is given, the backstop for a path that reaches an endpoint anyway.

The last tests walk the real application's routes. They are the ones that keep
this true: an endpoint added next year with a ``project_dir`` parameter or body
field fails here rather than shipping a hole.
"""

from __future__ import annotations

import inspect
import sys
import typing
from pathlib import Path
from types import SimpleNamespace

import pytest

_REPO = Path(__file__).resolve().parents[2]
_BACKEND = _REPO / "apps" / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from fastapi import Body  # noqa: E402
from pydantic import BaseModel  # noqa: E402
from server import config as server_config  # noqa: E402

_VALID_SECRET = "x" * 48


# At module level, not in the fixture: this module postpones its annotations,
# and FastAPI resolves a route's parameter types against the module's globals.
class _ScanRequest(BaseModel):
    name: str = ""
    project_dir: str | None = None


class _Options(BaseModel):
    depth: int = 1


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


def _bearer() -> dict[str, str]:
    """A valid access token for a user the database has never seen."""
    from server.auth.jwt_tokens import create_access_token

    user = SimpleNamespace(
        id="u-1", email="u@example.test", display_name="U", role="member"
    )
    token, _ = create_access_token(user)
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def server_app(monkeypatch, tmp_path):
    """A server-mode app with one route per way a body can carry a path.

    The principal lookup is stubbed: what is under test is what the middleware
    does with an authenticated request, not how it resolves the tenant.
    Every route records the body it was handed, so a test can tell "refused
    before the route" from "refused by the route".
    """
    _enable_server_mode(monkeypatch, tmp_path / "repos")

    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from server import integration

    async def _no_principal(request, claims):
        request.state.principal = None

    monkeypatch.setattr(integration, "_attach_principal", _no_principal)

    reached: list = []
    app = FastAPI()

    @app.post("/api/model")
    def _model(req: _ScanRequest):
        reached.append(req.model_dump())
        return {"ok": True}

    @app.post("/api/embedded")
    def _embedded(req: _ScanRequest, options: _Options):
        reached.append(req.model_dump())
        return {"ok": True}

    @app.post("/api/free")
    def _free(payload: typing.Annotated[dict, Body()]):
        reached.append(payload)
        return {"ok": True}

    @app.get("/api/timeline/{cid}")
    def _legacy(cid: str, project_dir: str = ""):  # pragma: no cover
        reached.append(cid)
        return {"cid": cid}

    assert integration.mount_server_mode(app) is True
    with TestClient(app) as client:
        yield SimpleNamespace(client=client, reached=reached, headers=_bearer())


class TestValidatedDirConfinement:
    """The chokepoint every path-taking endpoint already funnels through."""

    def test_local_mode_still_accepts_any_directory(self, monkeypatch, tmp_path):
        """The desktop app must lose nothing: there is no boundary to draw."""
        monkeypatch.setenv("WORKPILOT_SERVER_MODE", "0")
        server_config.reset_settings_cache()
        from foundation.api_safety import validated_dir

        somewhere = tmp_path / "anywhere"
        somewhere.mkdir()
        assert validated_dir(str(somewhere), "project_dir") == somewhere.resolve()

    def test_server_mode_confines_to_repos_root(self, monkeypatch, tmp_path):
        repos_root = tmp_path / "repos"
        (repos_root / "proj-a").mkdir(parents=True)
        _enable_server_mode(monkeypatch, repos_root)

        from foundation.api_safety import validated_dir

        inside = repos_root / "proj-a"
        assert validated_dir(str(inside), "project_dir") == inside.resolve()

    def test_server_mode_refuses_a_path_outside_repos_root(self, monkeypatch, tmp_path):
        """The cross-tenant read this whole change exists to prevent."""
        repos_root = tmp_path / "repos"
        repos_root.mkdir()
        outside = tmp_path / "etc"
        outside.mkdir()
        _enable_server_mode(monkeypatch, repos_root)

        from foundation.api_safety import validated_dir

        with pytest.raises(ValueError, match="outside every allowed root"):
            validated_dir(str(outside), "project_dir")

    def test_an_explicit_allowed_root_still_wins(self, monkeypatch, tmp_path):
        """A caller that genuinely needs another root says so."""
        repos_root = tmp_path / "repos"
        repos_root.mkdir()
        other = tmp_path / "other"
        other.mkdir()
        _enable_server_mode(monkeypatch, repos_root)

        from foundation.api_safety import validated_dir

        assert validated_dir(str(other), "d", allowed_roots=[other]) == other.resolve()

    def test_traversal_is_still_refused(self, monkeypatch, tmp_path):
        repos_root = tmp_path / "repos"
        repos_root.mkdir()
        _enable_server_mode(monkeypatch, repos_root)

        from foundation.api_safety import validated_dir

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

    def test_an_authenticated_query_string_path_is_refused(self, server_app):
        response = server_app.client.get(
            "/api/timeline/x?project_dir=/etc", headers=server_app.headers
        )
        assert response.status_code == 400
        assert "project_dir" in response.json()["detail"]
        assert server_app.reached == []


class TestMiddlewareRejectsBodySuppliedPaths:
    """The rule names the body too: a path is a path wherever the client puts it."""

    def test_a_json_body_field_is_refused_before_the_route(self, server_app):
        response = server_app.client.post(
            "/api/model",
            json={"name": "scan", "project_dir": "/srv/repos/other-tenant"},
            headers=server_app.headers,
        )
        assert response.status_code == 400
        assert "project_dir" in response.json()["detail"]
        assert server_app.reached == []

    def test_a_model_embedded_under_its_parameter_name_is_refused(self, server_app):
        """Two body parameters: FastAPI nests each model under its name."""
        response = server_app.client.post(
            "/api/embedded",
            json={"req": {"projectDir": "/etc"}, "options": {"depth": 2}},
            headers=server_app.headers,
        )
        assert response.status_code == 400
        assert "projectDir" in response.json()["detail"]
        assert server_app.reached == []

    def test_a_bare_dict_body_is_refused(self, server_app):
        """`/api/slash-commands/run` shape: no signature shows the key."""
        response = server_app.client.post(
            "/api/free",
            json={"command": "plan", "args": [{"cwd": "/"}]},
            headers=server_app.headers,
        )
        assert response.status_code == 400
        assert "cwd" in response.json()["detail"]
        assert server_app.reached == []

    def test_a_json_body_without_a_content_type_is_still_read(self, server_app):
        """FastAPI parses an untyped body as JSON, so the middleware must too."""
        response = server_app.client.post(
            "/api/free",
            content=b'{"spec_dir": "/etc"}',
            headers={**server_app.headers, "Content-Type": ""},
        )
        assert response.status_code == 400
        assert server_app.reached == []

    def test_a_form_field_is_refused(self, server_app):
        response = server_app.client.post(
            "/api/free", data={"file_path": "/etc/passwd"}, headers=server_app.headers
        )
        assert response.status_code == 400
        assert "file_path" in response.json()["detail"]
        assert server_app.reached == []

    def test_a_clean_body_reaches_the_route_intact(self, server_app):
        """Reading the body in the middleware must not consume it."""
        response = server_app.client.post(
            "/api/model", json={"name": "scan"}, headers=server_app.headers
        )
        assert response.status_code == 200
        assert server_app.reached == [{"name": "scan", "project_dir": None}]

    def test_a_path_as_a_value_is_not_a_key(self, server_app):
        """Only the key is judged: a body may *mention* a path."""
        response = server_app.client.post(
            "/api/free",
            json={"note": "project_dir", "text": "/etc/passwd"},
            headers=server_app.headers,
        )
        assert response.status_code == 200

    def test_malformed_json_is_left_to_the_route(self, server_app):
        response = server_app.client.post(
            "/api/model",
            content=b'{"project_dir": ',
            headers={**server_app.headers, "Content-Type": "application/json"},
        )
        assert response.status_code == 422
        assert server_app.reached == []

    def test_local_mode_reads_no_body(self, monkeypatch):
        """The desktop app keeps its exact behaviour: no middleware at all."""
        monkeypatch.setenv("WORKPILOT_SERVER_MODE", "0")
        server_config.reset_settings_cache()

        from fastapi import FastAPI
        from server.integration import mount_server_mode

        assert mount_server_mode(FastAPI()) is False


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


def body_field_names(route) -> set[str]:
    """Every key a route's body can carry.

    The parameter names (FastAPI nests a model under its name when a route has
    several body parameters), every field of every model reachable from them,
    and each field's alias — the spelling the client actually sends.
    """
    names: set[str] = set()

    def visit(annotation, seen: set) -> None:
        if typing.get_origin(annotation) is not None:
            for argument in typing.get_args(annotation):
                visit(argument, seen)
            return
        if not (isinstance(annotation, type) and issubclass(annotation, BaseModel)):
            return
        if annotation in seen:
            return
        seen.add(annotation)
        for name, field in annotation.model_fields.items():
            names.add(name)
            if field.alias:
                names.add(field.alias)
            visit(field.annotation, seen)

    for param in route.dependant.body_params:
        names.add(param.alias)
        visit(param.field_info.annotation, set())
    return names


#: Path-like body fields that are not a filesystem path the server opens on the
#: client's word. Each one says why; the list is checked for stale entries.
BODY_FIELD_EXEMPTIONS: dict[tuple[str, str], str] = {
    ("/api/docintel/whiteboard", "path"): (
        "the name of one of the task's own attachments, looked up in the list "
        "the server builds from the spec directory; never opened as given"
    ),
    ("/api/brain/settings", "path"): (
        "the brain routes answer only in local mode (`brain.api._refused`)"
    ),
    ("/api/brain/instruction", "path"): (
        "the brain routes answer only in local mode (`brain.api._refused`)"
    ),
}


class TestRouteCoverage:
    """Walk the real app and refuse any unguarded path parameter."""

    # provider_api mounts every feature router inside try/except, so a missing
    # optional dependency drops the router silently and this test would sweep
    # an almost-empty app and pass. Below this many routes it is not testing
    # anything, and saying so is worth more than a green tick.
    MIN_MEANINGFUL_ROUTES = 60

    @staticmethod
    def _load_app():
        """The real application, or skip when its dependencies are absent.

        The bare ``raise`` is unreachable — ``pytest.skip`` raises ``Skipped``
        — and it is there to say so. Without it the ``except`` branch falls off
        the end and returns ``None``, so the function would depend on a
        library's control flow to never hand its caller a null app. Making the
        branch explicitly terminal states the contract instead of relying on it.
        """
        try:
            from provider_api import app

            return app
        except Exception as exc:  # pragma: no cover - dependency-dependent
            pytest.skip(f"provider_api could not be imported: {exc}")
            raise

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

    def test_no_route_declares_an_unprotected_path_parameter(
        self, monkeypatch, tmp_path
    ):
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

    def test_no_route_takes_an_unprotected_path_in_its_body(self):
        """The same rule for the body, which a signature does not show.

        A route taking ``req: ScanRequest`` has one parameter called ``req``;
        the ``project_path`` is a field of the model. The sweep above never saw
        those, so it passed while forty routes took a path in their body. A
        field is acceptable when the middleware refuses its key in a body
        (it is in ``CLIENT_PATH_PARAMS``), or when ``BODY_FIELD_EXEMPTIONS``
        says why it is not a path the server opens.
        """
        from server.integration import CLIENT_PATH_PARAMS

        suspicious = []
        for route in self._routes():
            for name in sorted(body_field_names(route)):
                lowered = name.lower()
                if "dir" not in lowered and "path" not in lowered:
                    continue
                if name in CLIENT_PATH_PARAMS:
                    continue  # refused by the middleware, query or body
                if (route.path, name) in BODY_FIELD_EXEMPTIONS:
                    continue
                suspicious.append(f"{sorted(route.methods)} {route.path} :: {name}")

        assert not suspicious, (
            "These routes take a path-like field in their body that the "
            "middleware does not refuse. Either add the key to "
            "server.integration.CLIENT_PATH_PARAMS, take a project_id and use "
            "server.authz.scope.resolve_project_scope, or — if it is not a "
            "filesystem path the server opens — add it to "
            "BODY_FIELD_EXEMPTIONS with the reason:\n  "
            + "\n  ".join(sorted(suspicious))
        )

    def test_every_body_exemption_still_names_a_real_field(self):
        """An exemption outliving its field would quietly cover the next one."""
        fields = {
            (route.path, name)
            for route in self._routes()
            for name in body_field_names(route)
        }
        stale = sorted(set(BODY_FIELD_EXEMPTIONS) - fields)
        assert not stale, f"Exemptions naming no route field any more: {stale}"

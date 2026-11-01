"""A person's interface preferences (``server.routers.preferences``).

What is checked: a person reads ``null`` before choosing, a saved choice is
read back and replaced, each person sees only their own row, anything
outside the closed lists (mode, colour theme, extra or missing fields,
non-strings) is refused with 422, the route needs a signed-in person, it is
mounted in server mode, and the server's lists match the desktop's themes.
"""

from __future__ import annotations

import asyncio
import re
import sys
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[2]
_BACKEND = _ROOT / "apps" / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from server import config as server_config  # noqa: E402

_PATH = "/users/me/preferences"


@pytest.fixture(autouse=True)
def _clean_settings(monkeypatch, tmp_path):
    for key in list(server_config.os.environ):
        if key.startswith("WORKPILOT_"):
            monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("WORKPILOT_SERVER_MODE", "1")
    monkeypatch.setenv("WORKPILOT_JWT_SECRET", "x" * 48)
    monkeypatch.setenv(
        "WORKPILOT_DATABASE_URL",
        "sqlite+aiosqlite:///" + str(tmp_path / "prefs.sqlite3").replace("\\", "/"),
    )
    server_config.reset_settings_cache()
    yield
    server_config.reset_settings_cache()


async def _fresh_db():
    from server.db import engine as db_engine

    db_engine._engine = None
    db_engine._session_factory = None
    await db_engine.init_db()
    return db_engine.get_session_factory()()


async def _users(*emails: str) -> list:
    from server.auth.local import create_local_user

    async with await _fresh_db() as db:
        return [
            await create_local_user(
                db,
                email=email,
                password="correct-horse-battery-staple",
                display_name="P",
            )
            for email in emails
        ]


@pytest.fixture
def people():
    """Two people, and a client of the route signed in as one or the other."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from server.auth.deps import CurrentUser, get_current_user
    from server.routers import preferences

    me, other = asyncio.run(_users("me@example.com", "other@example.com"))
    app = FastAPI()
    app.include_router(preferences.router)
    current = {"user": me}
    app.dependency_overrides[get_current_user] = lambda: CurrentUser(
        id=current["user"].id,
        email=current["user"].email,
        display_name="P",
        role="member",
    )

    def sign_in(who):
        current["user"] = who

    with TestClient(app) as client:
        yield client, sign_in, me, other


class TestRoute:
    def test_nothing_chosen_reads_null(self, people):
        client, *_ = people
        res = client.get(_PATH)
        assert res.status_code == 200
        assert res.json() == {"theme": None, "colorTheme": None}

    def test_a_choice_is_kept_and_replaced(self, people):
        client, *_ = people
        saved = client.put(_PATH, json={"theme": "dark", "colorTheme": "ocean"})
        assert saved.status_code == 200, saved.text
        assert saved.json() == {"theme": "dark", "colorTheme": "ocean"}
        assert client.get(_PATH).json() == {"theme": "dark", "colorTheme": "ocean"}
        client.put(_PATH, json={"theme": "system", "colorTheme": "forest"})
        assert client.get(_PATH).json() == {"theme": "system", "colorTheme": "forest"}

    def test_each_person_reads_and_writes_only_their_own(self, people):
        client, sign_in, me, other = people
        client.put(_PATH, json={"theme": "light", "colorTheme": "neo"})
        sign_in(other)
        assert client.get(_PATH).json() == {"theme": None, "colorTheme": None}
        client.put(_PATH, json={"theme": "dark", "colorTheme": "retro"})
        sign_in(me)
        assert client.get(_PATH).json() == {"theme": "light", "colorTheme": "neo"}

    @pytest.mark.parametrize(
        "body",
        [
            {"theme": "sepia", "colorTheme": "default"},
            {"theme": "dark", "colorTheme": "solarized"},
            {"theme": "DARK", "colorTheme": "default"},
            {"theme": "dark"},
            {"colorTheme": "default"},
            {"theme": "dark", "color_theme": "default"},
            {"theme": "dark", "colorTheme": "default", "fontSize": 20},
            {"theme": 1, "colorTheme": "default"},
            {"theme": "dark", "colorTheme": ["default"]},
            {"theme": None, "colorTheme": None},
            [],
        ],
    )
    def test_anything_else_is_refused(self, people, body):
        client, *_ = people
        assert client.put(_PATH, json=body).status_code == 422
        assert client.get(_PATH).json() == {"theme": None, "colorTheme": None}

    def test_the_route_needs_a_signed_in_person(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from server.routers import preferences

        app = FastAPI()
        app.include_router(preferences.router)
        with TestClient(app) as client:
            assert client.get(_PATH).status_code == 401
            put = client.put(_PATH, json={"theme": "dark", "colorTheme": "default"})
            assert put.status_code == 401

    def test_the_route_is_mounted_in_server_mode(self):
        source = (_BACKEND / "server" / "integration.py").read_text(encoding="utf-8")
        assert '("server.routers.preferences", "preferences")' in source


class TestService:
    @pytest.mark.asyncio
    async def test_the_service_refuses_an_unknown_value(self):
        from server.services.preferences import set_preferences

        (me,) = await _users("svc@example.com")
        async with await _fresh_db() as db:
            with pytest.raises(ValueError):
                await set_preferences(db, me.id, "dark", "solarized")


def test_the_lists_match_the_desktop():
    """A theme added on the desktop must be added on the server and the phone."""
    from server.services.preferences import COLOR_THEMES, THEME_MODES

    themes = (_ROOT / "apps/frontend/src/shared/constants/themes.ts").read_text(
        encoding="utf-8"
    )
    assert set(re.findall(r'^\t\tid: "(\w+)"', themes, re.M)) == COLOR_THEMES
    settings = (_ROOT / "apps/frontend/src/shared/types/settings.ts").read_text(
        encoding="utf-8"
    )
    assert 'theme: "light" | "dark" | "system";' in settings
    assert THEME_MODES == {"light", "dark", "system"}
    ids = (_ROOT / "apps/mobile/src/ui/theme-ids.ts").read_text(encoding="utf-8")
    listed = re.search(r"COLOR_THEME_IDS = \[([^\]]*)\]", ids)
    assert listed is not None
    assert set(re.findall(r'"(\w+)"', listed.group(1))) == COLOR_THEMES
    palettes = (_ROOT / "apps/mobile/src/ui/palettes.ts").read_text(encoding="utf-8")
    for theme in COLOR_THEMES:
        assert re.search(rf"^\t{theme}: \{{$", palettes, re.M), theme

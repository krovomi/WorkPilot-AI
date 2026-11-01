"""Server mode: the engines the phone offers when it creates a card.

The New card screen could only send no engine (the deployment's default): it
had no list of the providers the server accepts. ``GET /api/board/engines``
gives it that list, read-only, to a member of the project.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import pytest

_BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))


def test_each_listed_engine_is_one_a_card_may_be_created_with():
    from shared_board.engines import list_engines
    from shared_board.settings import MODEL_PATTERN, CardEngine

    engines = list_engines()
    names = [e["provider"] for e in engines]
    assert "claude" in names and "openai" in names
    assert len(names) == len(set(names))
    for engine in engines:
        assert engine["label"]
        # The settings accept the provider, and each model id it lists.
        CardEngine(provider=engine["provider"])
        for model in engine["models"]:
            assert re.match(MODEL_PATTERN, model["id"])
            CardEngine(provider=engine["provider"], model=model["id"])


def test_a_provider_without_an_adapter_is_not_offered():
    from shared_board.engines import list_engines
    from skills_registry.providers import load_providers

    without = {n for n, c in load_providers().items() if not c.has_adapter}
    assert without, "the matrix has providers that degrade (meta, aws, ...)"
    assert not without & {e["provider"] for e in list_engines()}


def test_claude_is_named_and_given_its_models_from_the_catalogue():
    from shared_board.engines import list_engines

    claude = next(e for e in list_engines() if e["provider"] == "claude")
    assert claude["label"] != "claude"
    assert claude["models"]
    assert claude["effort"] == "thinking_budget"


def test_a_model_the_settings_would_refuse_is_left_out(monkeypatch):
    from shared_board import engines

    monkeypatch.setattr(
        engines,
        "_catalogue",
        lambda: {
            "openai": {
                "label": "OpenAI",
                "models": [
                    {"value": "gpt-5.5", "label": "GPT-5.5"},
                    {"value": "bad model; rm -rf", "label": "x"},
                    {"value": "", "label": "empty"},
                ],
            }
        },
    )
    openai = next(e for e in engines.list_engines() if e["provider"] == "openai")
    assert openai["models"] == [{"id": "gpt-5.5", "label": "GPT-5.5"}]
    # A provider the catalogue does not know still gets a name.
    pi = next(e for e in engines.list_engines() if e["provider"] == "pi")
    assert pi["label"] == "pi" and pi["models"] == []


@pytest.mark.asyncio
async def test_the_route_answers_a_member_with_the_list():
    from server.authz.scope import ProjectScope
    from shared_board.engines import get_engines, list_engines

    scope = ProjectScope("p-1", "o-1", Path("."), "viewer")
    assert await get_engines(scope) == {"engines": list_engines()}


def test_the_route_is_a_read_of_the_board_and_takes_a_project():
    from server.authz.mounting import permission_for
    from shared_board.engines import router

    assert permission_for("GET", "/api/board/engines", "task") == "task.read"
    route = next(r for r in router.routes if r.path == "/api/board/engines")
    params = {p.name for p in route.dependant.dependencies[0].query_params}
    assert "project_id" in params


def test_the_board_mounts_the_engines_route():
    from shared_features import mount_all

    mounted: list[tuple[str, str]] = []
    mount_all(
        lambda router, feature: mounted.extend((r.path, feature) for r in router.routes)
    )
    assert ("/api/board/engines", "board") in mounted

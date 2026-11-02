"""The engines a server card may be created with, for the phone's New card screen.

A card's engine names a provider of the capability matrix
(``capabilities/providers.yaml``, checked by ``shared_board.settings``), and
the phone had no way to know which: it could only send nothing and get the
deployment's default. This lists them, read-only, with the name a person
reads and the models the provider catalogue knows for it
(``services.provider_registry``), so the phone offers a pick list instead of
a guess.

Only a provider with an adapter is listed: one without (``adapter: null``)
runs as the provider it degrades to, and offering it would be offering a
choice that does not happen. A model whose id the settings would refuse
(``MODEL_PATTERN``) is left out. Credentials are the deployment's, as for
every run on the server; nothing here says whether they are configured.

The route takes a ``project_id`` like every board route, so only a member of a
project reads it; the mount gives it ``task.read``.
"""

from __future__ import annotations

import re
from typing import Any

from fastapi import APIRouter, Depends
from server.authz.scope import ProjectScope, resolve_project_scope
from shared_board.settings import MODEL_PATTERN

router = APIRouter(prefix="/api/board", tags=["board"])

#: The catalogue spells some providers the way the desktop UI does.
CATALOGUE_NAMES = {"claude": "anthropic"}
#: The most models sent for one provider.
MAX_MODELS = 50
_MODEL = re.compile(MODEL_PATTERN)


def _catalogue() -> dict[str, dict[str, Any]]:
    """The provider catalogue (a static list) by name."""
    from services.provider_registry import provider_registry

    return {p["name"]: p for p in provider_registry.get_all_providers()}


def _models(entry: dict[str, Any] | None) -> list[dict[str, str]]:
    models: list[dict[str, str]] = []
    for model in (entry or {}).get("models") or []:
        value = str(model.get("value") or "")
        if not _MODEL.match(value):
            continue
        models.append({"id": value, "label": str(model.get("label") or value)})
        if len(models) >= MAX_MODELS:
            break
    return models


def list_engines() -> list[dict[str, Any]]:
    """Each provider a card may run on, in the matrix's order."""
    from skills_registry.providers import load_providers

    catalogue = _catalogue()
    engines: list[dict[str, Any]] = []
    for name, caps in load_providers().items():
        if not caps.has_adapter:
            continue
        entry = catalogue.get(CATALOGUE_NAMES.get(name, name))
        label = (entry or {}).get("label") or (caps.acp.label if caps.acp else name)
        engines.append(
            {
                "provider": name,
                "label": str(label),
                # "none" when the provider takes no effort level.
                "effort": caps.effort,
                "models": _models(entry),
            }
        )
    return engines


@router.get("/engines")
async def get_engines(
    scope: ProjectScope = Depends(resolve_project_scope),
) -> dict[str, Any]:
    """The providers and models a card of this project may be created with."""
    return {"engines": list_engines()}

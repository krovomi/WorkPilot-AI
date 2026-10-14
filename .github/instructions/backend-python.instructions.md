---
applyTo: 'apps/backend/**/*.py,src/**/*.py'
description: 'Conventions backend Python WorkPilot AI : FastAPI, agents multi-LLM, ruff, pytest.'
---

# Backend Python — Instructions

> Résumé pour Copilot. Les règles normatives sont dans `docs/rules/backend.md` et `docs/rules/security.md` ; elles priment.

## Stack

- **Python 3.12+** (Python embarqué par l'app : 3.12 ; la CI teste aussi 3.13).
- **FastAPI** comme façade HTTP (`apps/backend/api/`, `apps/backend/websocket_server.py`).
- Agents organisés en modules par domaine au niveau racine de `apps/backend/` (un dossier par capability : `accessibility_agent/`, `adversarial_qa/`, `architecture/`, etc.).
- LLM providers via `apps/backend/provider_api.py` + `provider_models_catalog.py`.
- **Ruff** pour lint+format (`ruff.toml`, double quotes, indent spaces).
- **pytest** pour tests (`pytest.ini`, `tests/`).

## Règles

1. Imports **plats** depuis `apps/backend` (`from phase_config import …`, `from core.client import …`) : `pytest.ini` pose `pythonpath = apps/backend . ./src`. Jamais `from apps.backend…`. Pas de wildcard.
2. Toute fonction publique a un docstring + types annotés.
3. Pas de `print()` — utiliser le `logging` standard avec niveau approprié.
4. Aucune clé API en clair : identifiants dans `.env-files/.env` (ignoré par git) ou le trousseau de l'OS ; jamais dans un log, un prompt ou un test.
5. Endpoints FastAPI dans `apps/backend/api/` ; logique métier dans les modules dédiés.
6. Slash commands : `apps/backend/slash_commands/` sert `.agents/skills/*/SKILL.md` (repli : `.claude/commands/*.md`).
7. Tout module nouveau doit déclarer ses dépendances via `__init__.py` minimal.
8. Tout appel LLM passe par `create_client()` / `create_agent_client()` de `core.client` — jamais `anthropic.Anthropic()`.
9. Contenu externe (issue, PR, ticket, page web) : `security/untrusted.py` avant tout prompt. Sous-processus : liste d'arguments, `shell=False`.

## Tests

- Dans `tests/<paquet>/` ; un seul `pytest.ini`, à la racine : `pytest tests/ -v` depuis la racine.
- `tests/conftest.py` pour les fixtures partagées.
- Mocker les LLM via les fixtures existantes (pas d'appel réseau).

## Token-saving

- Beaucoup de modules — utiliser `grep` ciblé.
- Voir `apps/backend/AGENTS.md` pour la cartographie.

## Anti-patterns

- Appeler un provider LLM sans passer par `core/client.py`.
- Sleep synchrone dans un endpoint FastAPI — utiliser `asyncio.sleep`.
- Lecture / écriture filesystem hors de `core/workspace/` / `core/worktree.py` ; un chemin reçu se résout (`Path.resolve()`) puis se vérifie dans une racine autorisée.

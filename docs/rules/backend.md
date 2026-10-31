# Règles backend (Python)

> **Normatif** pour `apps/backend/`, `src/` et `tests/`. Chargé par Claude Code dès qu'il lit un
> fichier de `apps/backend/` ; carte du code : [`apps/backend/AGENTS.md`](../../apps/backend/AGENTS.md).
> Sécurité : [`security.md`](security.md). Noyau : [`docs/CLAUDE.md`](../CLAUDE.md).

## Clients LLM : une seule fabrique

Toute interaction avec un modèle passe par le Claude Agent SDK. **Jamais** `anthropic.Anthropic()`
en direct : `create_client()` (SDK Claude) ou `create_agent_client()` (multi-provider), tous deux
dans `core/client.py`. Seuls `core/client.py` et `core/simple_client.py` construisent un
`ClaudeAgentOptions`.

Une unité que `core` ou `agents` importe (merge, intégrations, analyse, architecture) ne les
importe pas en retour pour lancer une session : elle passe par le port `agent_runtime`
(`agent_runtime.current()`), que `core` installe et qui appelle ces mêmes fabriques.
→ [`architecture/agent-runtime.md`](../architecture/agent-runtime.md)

Le modèle et le budget de réflexion se résolvent par phase, depuis les réglages de l'utilisateur :

```python
from core.client import create_client
from phase_config import get_phase_model, get_phase_thinking_budget

client = create_client(
    project_dir=project_dir,
    spec_dir=spec_dir,
    model=get_phase_model(spec_dir, "coding", cli_model=None),
    agent_type="coder",  # planner | coder | qa_reviewer | qa_fixer | …
    max_thinking_tokens=get_phase_thinking_budget(spec_dir, "coding", cli_thinking=None),
)
async with client:
    status, response = await run_agent_session(client, prompt, spec_dir)
```

Exemples vivants : `agents/planner.py`, `agents/coder.py`, `qa/reviewer.py`, `qa/fixer.py`, `spec/`.
Un identifiant de modèle ne s'écrit pas en dur : il vient de `phase_config.py` ou de
`models_registry.py` (puis `python scripts/generate_model_catalog.py`, vérifié par `--check`).

## Un agent a les outils qu'il déclare

`AGENT_CONFIGS[agent_type]["tools"]` (`agents/tools_pkg/models.py`) s'applique sur **tous** les providers :

- `create_client` et `create_simple_client` passent `undeclared_builtin_tools` en `disallowed_tools` ;
- `ToolExecutor(agent_type=…)` n'offre et n'exécute que ce que le type déclare ;
- Codex tourne en `--sandbox read-only` pour un type qui n'écrit ni n'exécute de commande ;
- pi reçoit la déclaration comme allowlist `--tools` (dans ses mots, par `capabilities/harnesses.yaml`), et le garde-fou d'écriture de `path_guard` chargé dans son processus ;
- le client simple n'a pas de hooks et refuse un type qui déclare `Write`, `Edit` ou `Bash`.

Un prompt qui utilise un outil que son type ne déclare pas fait échouer
`tests/test_agent_tool_declarations.py` : déclarer l'outil, ne pas compter sur les autorisations
générales du fichier de réglages. Hors SDK, commandes, écritures et serveurs MCP passent les mêmes
contrôles. Pourquoi : [`architecture/agent-tool-rights.md`](../architecture/agent-tool-rights.md).

## L'authentification appartient au provider qui en a besoin

Le jeton OAuth Claude Code ne conditionne que les builds Claude. Demander
`core.auth.provider_requires_claude_oauth(provider)` avant de l'exiger, et résoudre le provider
avec `core.client.peek_active_provider` — jamais `_get_active_provider`, qui consomme le marqueur à
usage unique `RESUME_WITH_PROVIDER`. Un `if not get_auth_token()` global a déjà fait accepter par
le frontend puis refuser par le backend une tâche configurée pour Ollama.

## Signaux de build

`BuildPaused` / `BuildHalted` (`foundation/build_signals.py`) remontent jusqu'à `handle_build_command` :
ne pas les attraper en chemin. Le drapeau de pause coopérative est `foundation/pause_state.py`, lu par le
coder, la QA et la spec. Voir [`architecture/pause-resume.md`](../architecture/pause-resume.md).

## Une porte par question

| Question | La seule réponse | Ne pas |
|---|---|---|
| Quelle pile technique ? | `project/stack.py` | écrire un nouveau détecteur |
| Frontmatter d'un skill ? | `skills_registry.frontmatter.parse_frontmatter` | parser du YAML à la main |
| Mémoire des builds ? | `brain/project_memory.py` (le vault) | ouvrir un second magasin |
| OS, exécutables, chemins ? | `foundation/platform/` (`is_windows`, `find_executable`, `requires_shell`…) | lire `sys.platform` / `os.name` |
| Projet hors-ligne strict ? | `offline_policy/` | appeler un service cloud sans passer par lui |
| Appli mobile constructible ici ? | `mobile/readiness.py` | lancer un build iOS hors macOS |

**iOS ne se construit que sur macOS** : le signaler comme non vérifiable, ne jamais réessayer.

## Code Python

- **Python 3.12+** : le plancher (Python embarqué, image serveur, `target-version` de ruff) ; la CI
  teste 3.12 sur Linux et 3.13 sur les trois OS.
- Annotations de type sur toute signature publique ; **ruff `0.15.7`** exactement
  (`ruff check apps/backend tests src`, `ruff format --check …`).
- **Encodage explicite** : `open(..., encoding="utf-8")`, `Path.read_text(encoding="utf-8")`,
  `write_text(..., encoding="utf-8")` ; Windows ne lit pas l'UTF-8 par défaut. Vérification :
  `python scripts/check_encoding.py` ; détails dans [`windows-development.md`](../windows-development.md).
- **Imports plats** : `pytest.ini` pose `pythonpath = apps/backend . ./src` ; on écrit
  `from phase_config import …`, `from agents.coder import …`, jamais `from apps.backend…`.
- **Importer le module réel**, jamais un fichier de la racine qui le réexporte : `foundation.debug`,
  `core.worktree`, `qa`. Les cales de compatibilité ont été retirées.
- Un sous-processus prend une liste d'arguments, sans shell (règle S4 de [`security.md`](security.md)).
- **Attraper ce qu'on attend.** Un `except Exception` (ou `except:`) de plus dans un fichier est
  refusé : `tests/baselines/blind-except.json` plafonne chaque fichier à son compte du
  30 octobre 2026, et un corps qui ne fait que `pass` compte à part. Une correction fait baisser
  le plafond (`python scripts/quality_baselines.py update`, qui ne monte jamais) ; un relèvement
  s'écrit à la main dans le JSON et se justifie dans la PR.
- **Un gros fichier ne grossit plus.** Au-delà de 2 000 lignes, un fichier source (backend ou
  frontend) a un plafond dans `tests/baselines/file-size.json`, à sa taille du 30 octobre 2026 ;
  un nouveau fichier au-delà est refusé. Le code d'une feature va dans un module à lui ; une
  découpe abaisse le plafond (`python scripts/quality_baselines.py update`).
- **Types vérifiés** par pyright `1.1.408` (mode `basic`) sur les paquets listés dans
  `apps/backend/pyrightconfig.json` (`bench`, `best_of_n`, `genai_trace`, `goal`, `mcp_tasks`,
  `os_sandbox`, `security`) ; on élargit la liste paquet par paquet, une fois le paquet à zéro.
- **Contrats d'imports** entre unités de premier niveau (`tests/test_import_contracts.py`) :
  les unités listées dans `ALLOWED_IMPORTS` (`foundation`, `security`, `project`, `phase_config`,
  `offline_policy`, `harness`…) n'importent que ce qu'il leur accorde, et le plus grand cycle
  d'imports (`MAX_CYCLE`) ne grandit pas. Un import paresseux dans une fonction compte. Élargir un
  contrat se justifie dans la PR ; casser une partie du cycle fait baisser `MAX_CYCLE`.
- **Deux couches sous les agents.** `foundation/` est la plus basse : un utilitaire qui n'importe
  rien du backend y va (plateforme, sûreté des routes, écritures atomiques, git, événements de
  phase) et rien n'y importe `core`. `core/` est la racine de composition (`client.py`,
  `agent_clients/`, `worktree.py`) : il importe les agents, donc un module bas niveau qui y vit
  entraîne chacun de ses lecteurs dans le cycle des agents. Une fonctionnalité de bas niveau qui a
  besoin d'un LLM reçoit la fabrique de son appelant plutôt que d'importer `core`
  (`cost_intelligence.formula_refine`).

## Tests

- Ils vivent dans `tests/<paquet>/`, avec **une seule** configuration : le `pytest.ini` de la
  racine, lancé depuis la racine (CI comprise) : `pytest tests/ -v`.
- Aucun appel LLM réel : fixtures et doubles. `tests/conftest.py` isole les variables
  d'environnement du shell de l'appelant.
- Marqueurs : `unit`, `integration`, `e2e`, `streaming`, `performance`.
- Un correctif de bug arrive avec son test de régression ; un refus de sécurité, avec le test qui
  prouve le refus.
- Six modules de production portent le préfixe `test_` sans être des tests
  (`test_generation/generator.py`, `analysis/test_discovery.py`…) : ne pas les déplacer.

## Répertoire d'une spec

`.workpilot/specs/XXX-nom/` (ignoré par git) : `spec.md`, `requirements.json`, `context.json`,
`implementation_plan.json`, `qa_report.md`, `QA_FIX_REQUEST.md`. Une tâche s'exécute dans
`.workpilot/worktrees/tasks/<spec>/`.

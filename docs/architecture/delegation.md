# Délégation aux sous-agents sur tout provider

> Justification de conception. [`docs/CLAUDE.md`](../CLAUDE.md) reste l'autorité sur les règles.

## Le problème

Le registre `apps/backend/subagents/` compose un roster pour chaque session
(`resolve()` : défauts de phase, overlays de langage et mobile, agents de l'appelant, plafond).
Jusqu'ici ce roster n'atteignait le modèle que sur Claude : `create_client` le passe en
`agents=` au SDK, qui expose son outil `Agent`. La branche Copilot de `create_agent_client`
convertissait les agents fournis par l'appelant sans jamais appeler `resolve()`, et sa boucle
n'offrait aucun outil de délégation ; `providers.yaml` la déclarait pourtant `native`. Les
autres providers ignoraient le paramètre. Résultat : le profil de workflow annonçait
`subagent-per-task` pour la phase `coding` sur tout provider, et seul Claude déléguait.

## Trois états, pas deux

`capabilities/providers.yaml` distingue désormais :

| `subagents` | Qui | Comment le roster atteint le modèle |
|---|---|---|
| `native` | Claude | `agents=` du SDK, outil `Agent` |
| `emulated` | Copilot, OpenAI, Gemini, Ollama / LM Studio, Mistral, DeepSeek, Grok, Windsurf — tout client qui tourne sur la boucle WorkPilot | l'outil `delegate`, et une **session enfant** du même client par délégation |
| `none` | Codex, OpenCode, Antigravity, pi (des CLI qui apportent leurs outils), et les providers sans adaptateur | aucun ; l'engine dégrade `subagent-per-task` en `sequential-reset` |

`ProviderCapabilities.supports_subagents` vaut pour `native` et `emulated`. Le mode
`openai` + `OPENAI_AUTH_MODE=codex-cli` est le cas où la matrice statique ne suffit pas :
`workflows/engine.py` demande à `openai_uses_codex_cli()` avant de garder le dispatch.

## Comment une délégation s'exécute (`emulated`)

1. **Attachement** — `core.client.create_agent_client` construit le client
   (`_build_agent_client`, une branche par provider) puis, si `use_subagents` et
   `client.delegates()`, appelle `resolve()` et pose le roster sur `client.agents`, en
   `SubagentDefinition` (`_portable_roster` : alias de palier `sonnet`/`opus` → `inherit`).
   C'est un seul endroit pour tous les providers, au lieu d'un par branche.
2. **Offre** — `AgentClient._freeze_tools` ajoute **un** outil `delegate` au jeu figé de la
   session (`harness/domain/delegation.py`). Sa description liste les spécialistes avec leur
   `description` : c'est sur elle que le modèle choisit, comme le SDK le fait sur
   `AgentDefinition.description`. Un seul schéma quel que soit le roster : le jeu d'outils vit
   dans le préfixe mis en cache, et seule la description grandit, d'une ligne par spécialiste.
3. **Exécution** — `LoopAdapter.run_tool` intercepte `delegate` avant le pont MCP et
   `ToolExecutor`, et appelle `harness.application.delegation.run_delegation` :
   - `parent.spawn_child()` : copie superficielle du client, état transitoire remis à zéro
     (requête en attente, exécuteur, connexion, ledger, jeu d'outils, roster) ; identifiants,
     endpoint, modèle et projet sont partagés par référence ;
   - prompt système de l'enfant = préambule + rôle du spécialiste + contrat de retour
     (`with_contract`) ; `max_turns` = `CHILD_MAX_TURNS` (20) ; modèle du spécialiste s'il en
     nomme un ;
   - l'enfant entre dans son propre `__aenter__` (exécuteur, outils, pas de pont MCP), puis
     `_narrow_tools` restreint : `ToolExecutor.allowed_tools` au scope traduit du vocabulaire
     du registre (`Read`→`read_file`, `Grep`→`search_files`, `Bash`→`run_command`…, table
     `TOOL_TRANSLATION`) et le jeu figé est réduit aux mêmes noms. Le scope ne peut que
     **rétrécir** la déclaration du type parent : la porte du type passe d'abord ;
   - la tâche est l'unique message utilisateur ; l'enfant tourne la même boucle WorkPilot,
     dans le même worktree, sous les mêmes gardes (allowlist de commandes, écritures confinées) ;
   - son dernier message texte est le résultat : borné à `RESULT_CAP_TOKENS`, délimité comme
     donnée (`receive_result`, règle S2), enregistré sur le ledger du parent
     (`record_return`), et chaque appel de l'enfant est reporté sur ce ledger sous le fil
     `subagent:<nom>`.
4. **Vague** — plusieurs `delegate` dans un même tour s'exécutent ensemble
   (`harness/application/loop.py`, `_together`) et sont réinjectés dans l'ordre demandé ;
   les autres outils du tour suivent, séquentiels comme avant. Un échec d'enfant est un
   résultat que le parent lit, jamais une exception.
5. **Un seul niveau** — l'enfant a `agents = {}` et `delegation_scope` posé : il ne reçoit
   pas `delegate`, et `run_tool` refuse une délégation depuis un enfant.

## Ce qui ne change pas

- `AGENT_CONFIGS[agent_type]["tools"]` reste un droit : l'exécuteur de l'enfant est
  construit avec le `agent_type` du parent, et `allowed_tools` s'ajoute à cette porte.
- Le registre et son émission (`.agents/agents/`, `skills_registry/agents.py`) ne bougent pas.
- Claude garde la voie native ; `CopilotAgentClient.run_subagents` (vague sans outils, à
  partir d'un prompt) reste disponible pour un appelant qui a un prompt à distribuer plutôt
  qu'un modèle qui décide.

## Coût en tokens

Un roster coûte sa description dans le préfixe à chaque tour (une ligne par spécialiste) et,
par délégation, une session enfant dont seul le résultat borné revient. C'est le même
arbitrage que sur Claude : la phase `solo` n'en reçoit pas, le plafond reste à sept, et
l'enfant ne ponte aucun serveur MCP.

## Tests

`tests/harness/test_delegation.py` (traduction, outil, session enfant sur un client factice,
interception, vague), `tests/harness/test_delegation_end_to_end.py` (le vrai `OpenAIAgentClient`
contre un serveur OpenAI-compatible local scripté : outil `delegate` sur le fil, session enfant avec
les seuls outils du spécialiste, `run_command` réellement exécuté, conclusion bornée, ledger), `tests/test_agent_client_factory.py::TestRosterReachesEveryLoopClient`,
`tests/test_agent_tool_rights.py` (le scope ne s'élargit jamais),
`tests/test_provider_capabilities.py`, `tests/test_workflow_engine.py::TestCodexDispatch`.

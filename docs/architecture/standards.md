# Conformité aux standards ouverts (P4)

Un orchestrateur multi-provider gagne à parler les formats communs plutôt qu'à maintenir un
adaptateur par vendeur. La Linux Foundation a créé l'Agentic AI Foundation le 9 décembre 2025
avec MCP, goose et AGENTS.md ; Agent Trace et ACP suivent la même pente. Cette page dit ce que
WorkPilot parle, à quelle version, et ce qui atteint chaque provider. Elle est tenue par
`tests/test_provider_standards.py` : les versions citées sont celles du code, et chaque ligne
du tableau par provider est vérifiée contre le client qui tourne.

## Ce que WorkPilot parle

| Standard | Version | Où | Écart connu |
|---|---|---|---|
| MCP, côté serveur | MCP `2026-07-28` (`mcp_tasks/wire.py`), et l'ancienne ère : `2025-06-18`, `2025-03-26`, `2024-11-05` (`board_mcp/server.py`) | `board_mcp/`, `verify/mcp_server.py`, `shared_board/mcp_http.py`, sur `mcp_tasks.ToolServer` | `2025-11-25` n'est pas dans la liste de l'ancienne ère : un client qui la demande reçoit `2025-06-18`, ce que la négociation prévoit. |
| MCP, côté client | celle du SDK `mcp` installé | `core/mcp_tools.py` (boucle WorkPilot), le SDK Claude | Le test de santé du bureau (`mcp-handlers.ts`) s'annonce encore en `2024-11-05`. |
| ACP (Agent Client Protocol) | ACP version `1` | `core/agent_clients/acp.py`, détection dans `agent-cli-handlers.ts` | Seul Gemini CLI est déclaré (`acp:` dans `providers.yaml`). WorkPilot ne lui passe aucun serveur MCP (`mcpServers: []`). |
| AGENTS.md | le fichier à la racine du projet | `core/project_instructions.py` (injection), `capabilities/harnesses.yaml` (où chaque outil le lit) | Claude lit `CLAUDE.md` : un projet qui n'a qu'`AGENTS.md` ne l'atteint que par un `@AGENTS.md`. |
| OpenTelemetry GenAI | conventions `gen_ai.*`, statut « Development » | `genai_trace/` ([genai-traces.md](genai-traces.md)) | Les conventions bougent encore : un nom d'attribut peut changer. |

## Ce qui atteint chaque provider

Lu de `capabilities/providers.yaml`, champ `standards`. `unverified` veut dire « pas encore
vérifié », jamais « pris en charge ». Un provider sans adaptateur (Meta, AWS, Cursor, custom)
n'a pas de ligne : il tourne comme son `degrades_to`.

| Provider | MCP | Instructions du projet |
|---|---|---|
| `claude` | native : le SDK reçoit les serveurs configurés | `claude_md` |
| `copilot` | none : la boucle exécute ses outils sans pont MCP | `agents_md` |
| `windsurf` | none | injected |
| `openai` | bridged (avec le CLI Codex, aussi sa propre config `.codex/config.toml`) | injected |
| `google` | bridged | injected |
| `ollama` | bridged | injected |
| `local` | bridged | injected |
| `lmstudio` | bridged | injected |
| `mistral` | bridged | injected |
| `deepseek` | bridged | injected |
| `grok` | bridged | injected |
| `opencode` | own : sa propre config | `agents_md` |
| `pi` | own : `.pi/mcp.json`, chargé seulement dans un dépôt de confiance | `agents_md` |
| `gemini-cli` | own : sa propre config, rien par ACP | unverified : Gemini CLI lit `GEMINI.md` par défaut, `AGENTS.md` seulement si `context.fileName` le nomme |
| `antigravity` | unverified | unverified |

Le test vérifie chaque affirmation contre le code :

- `bridged` si et seulement si la classe du client a le pont MCP (`_bridge_mcp_tools`) ;
- `native` seulement pour le SDK Claude, `own` seulement pour un CLI ;
- `injected` si et seulement si la fabrique de `core/client.py` qui construit ce client lui
  donne le prompt avec `AGENTS.md` (`req.prompt(tool_use_hint=True)`).

Une valeur hors vocabulaire fait échouer le chargement de `providers.yaml`.

## Pas couvert

- Agent Trace : la trace d'attribution (F3) n'est pas encore fusionnée ; sa ligne viendra avec.
- Les écarts listés plus haut sont décrits, pas corrigés : chacun est un changement à lui.

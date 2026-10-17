# pi (pi.dev) — plan d'intégration par lots

> **Statut : lots 0, 1 et 2 livrés ; lots 3 à 5 à faire.** Un lot = une PR vers `develop`. Les lots sont ordonnés par
> dépendance, jamais par durée (règle 11 de `docs/CLAUDE.md`). Ce fichier devient la justification
> de conception de la feature (`docs/architecture/`, une ligne dans `docs/CLAUDE.md`) ; chaque lot
> livré remplace sa section « à faire » par ce qui a été fait, comme `context-harness.md`.
>
> Faits sur pi relevés le 16 octobre 2026 sur pi.dev/docs/latest et dans la source du dépôt
> `earendil-works/pi` (`main` à `698a2d2`, `packages/coding-agent` en version **1.3.0**). Le lot 0
> a tranché les douze points marqués **[à vérifier]** en lisant cette source (§ 3) ; ce qui reste à
> faire contre le binaire est la capture des fixtures, et elle est dite comme telle.

## 1. Ce qu'est pi, et ce qu'il est pour WorkPilot

[pi](https://pi.dev) est un agent de code en terminal, MIT, Node ≥ 22.19, « harness minimal » :
une boucle, des outils (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, `powershell` sur
Windows natif), des extensions TypeScript, des skills au standard
[Agent Skills](https://agentskills.io), des prompt templates, un support MCP intégré, et quatre
modes : TUI, `-p`/`--print`, `--mode json` (flux JSONL, une invocation) et `--mode rpc` (JSONL
bidirectionnel sur stdin/stdout, processus persistant).

Pour WorkPilot, pi a **deux visages**, et les deux précédents du dépôt disent exactement comment
traiter chacun :

| Visage | Précédent | Ce que ça veut dire |
|---|---|---|
| **Harness** : pi lit les instructions et les skills du dépôt, comme Claude Code, Codex ou hermes | hermes (`docs/architecture/hermes.md`) | une entrée dans `capabilities/harnesses.yaml` qui **n'émet rien** : pi lit nativement `AGENTS.md` et `.agents/skills/`, déjà committés ; un miroir `.pi/skills/` dupliquerait 390 fichiers |
| **Provider** : WorkPilot lance pi comme moteur d'une tâche | OpenCode (`core/agent_clients/opencode_cli.py`) | un `PiCliAgentClient` sur `CliSubprocessAgentClient`, une entrée dans `capabilities/providers.yaml`, une ligne dans `create_agent_client` |

C'est la différence avec hermes : hermes est un runtime qu'on **ne peut pas** piloter (pas de mode
non interactif stable), donc il n'est pas provider. pi expose un flux JSON et un protocole RPC
documentés : il **peut** l'être, et l'écrire dans `providers.yaml` est vrai.

Trois choses que pi fait et que WorkPilot doit respecter plutôt que contourner :

1. **La confiance est une décision de personne.** pi ne charge ni `.pi/extensions/`, ni
   `.pi/skills/`, ni `.agents/skills/`, ni `.pi/mcp.json` d'un projet tant que ce projet n'est pas
   approuvé : `/trust` dans le TUI, écrit dans `~/.pi/agent/trust.json` ; ou `-a/--approve` pour
   un processus ; ou `defaultProjectTrust: always` dans les réglages. **En mode json/rpc, aucune
   invite n'apparaît** : avec `ask` (le défaut), les ressources du projet sont **silencieusement
   ignorées**. C'est, mot pour mot, le mode de panne que `hermes.md` décrit pour
   `skills.trusted_project_dirs` (« hermes doesn't work here »). Même réponse : WorkPilot
   **ne passe jamais `--approve`** à la place de l'utilisateur, lit l'état et dit la commande qui
   le change.
2. **Aucune invite de permission.** « Pi runs with all permissions by default. » Les gardes
   (`permission-gate.ts`, `protected-paths.ts`, `sandbox/`) sont des extensions d'exemple. Les
   droits d'un type d'agent se posent donc **par l'allowlist d'outils** (`--tools`) — plus fort
   que ce qu'OpenCode permet (son agent `plan` est une instruction), et exactement ce que
   `AGENT_CONFIGS` déclare.
3. **Une extension s'exécute dans le processus pi** avec ses droits OS. Une extension dans un
   dépôt cloné est du code tiers (S8) : raison de plus pour ne pas approuver un projet à la
   place de quelqu'un.

### Non-objectifs (dits pour ne pas être redemandés)

- Pas de persona pi (`~/.pi/agent/SYSTEM.md`) : `SOUL.md` reste une offre pour hermes seul.
- Pas de second learning loop lisant `~/.pi/agent/sessions/` : l'ingestion des skills vient de
  hermes et du `observe` de WorkPilot (`hermes.md` : « deux boucles qui écrivent des skills, c'est
  une de trop »).
- Pas de sous-agents pi (`examples/extensions/subagent/`) : `subagents: none`, comme les autres
  CLI ; le moteur dégrade `subagent-per-task` en `sequential-reset`.
- Pas d'extension WorkPilot embarquée dans pi avant le lot 4, et seulement si le lot 2 en
  démontre le besoin (§ lot 4).

## 2. Invariants : ce qui ne doit pas bouger

À prouver par les commandes du § 7 à chaque lot.

| Invariant | Gardé par |
|---|---|
| Les sorties de skills ne changent pas (pi n'émet rien, `default: false`) | `pnpm run skills:check` sans diff |
| Hermes continue de lire `.agents/skills/` et `AGENTS.md` ; rien n'écrit sous `~/.hermes` | `tests/test_hermes_*.py` inchangés ; aucune nouvelle écriture dans `hermes/` |
| Le cerveau garde **une** table d'agents (`brain/agents.py`) ; `connect`/`bridge` n'écrivent que sur `--apply`, après sauvegarde | `tests/test_brain*.py` |
| JEV reste indépendant du provider ; `TYPESAFE_API_KEY` n'atteint jamais un sous-processus pi | `tests/test_jev_*.py` + un test au lot 2 |
| Le harness de contexte mesure pi dans l'unité commune ; pi apporte ses outils, leur poids est le sien | `tests/harness/` |
| Un type qui ne déclare ni `Write`, ni `Edit`, ni `Bash` ne peut pas écrire sur pi | `tests/test_pi_cli_client.py` (lot 2) |
| Aucun shell, aucun secret dans argv : prompt sur stdin, projet en `cwd`, chemins par variables d'environnement | `validated_option`, `_SAFE_OPTION_VALUE` |
| `tests/test_docs_context.py`, `test_provider_capabilities.py`, `test_skills_registry_*` verts | CI |

## 3. Lot 0 — Vérifier avant d'écrire (spike, aucune ligne de produit)

**But.** Transformer chaque **[à vérifier]** en fait, et capturer les fixtures qui deviennent le
contrat de l'adaptateur (comme `tests/test_opencode_cli_client.py` encode le flux d'OpenCode).

**Prérequis.** pi 1.3.0 installé sur la machine du développeur (`npm install -g --ignore-scripts
@earendil-works/pi-coding-agent`, ou `irm https://pi.dev/install.ps1 | iex` sous Windows), Node
≥ 22.19 (note : `.workpilot/skills.toml` cible Node 20 pour **ce** dépôt ; pi apporte son propre
Node, rien ne change ici), un provider connecté dans pi (`pi` puis `/login`, ou `ANTHROPIC_API_KEY`).

**Réponses, lues dans la source** (`packages/coding-agent/src/`, chemins cités pour que la
prochaine version de pi se revérifie au même endroit) :

| # | Question | Réponse | Où |
|---|---|---|---|
| V1 | `AGENTS.md` **et** `CLAUDE.md` dans le même dossier : les deux, ou le premier ? | **Le premier trouvé, dans l'ordre** `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD` — ici `AGENTS.md` gagne et `CLAUDE.md` n'est pas lu : rien à changer. Chargés : le fichier de `~/.pi/agent`, puis ceux de `cwd` et de **tous** ses parents (jusqu'à la racine du disque, pas du dépôt). Un worktree git imbriqué sous le dépôt principal (c'est le cas de `.workpilot/worktrees/tasks/<spec>/`) **masque** l'`AGENTS.md` du dépôt principal pour ne pas l'appliquer deux fois. | `core/resource-loader.ts` : `loadContextFileFromDir`, `loadProjectContextFiles`, `findShadowedContextFile` |
| V2 | `--skill <path>` : fichier ou dossier ? | **Dossier accepté, découverte récursive** (`loadSkillsFromDirInternal`), ou un `.md` seul ; chemin relatif résolu depuis `cwd` ; un chemin absent est un simple avertissement. Ces chemins sont de source `cli`, chargés **même avec `--no-skills`** et **sans passer par la confiance du projet** (seule la découverte automatique de `.pi/skills` et `.agents/skills` est gardée par `hasTrustRequiringProjectResources`). | `core/skills.ts` : `loadSkills` ; `core/trust-manager.ts` |
| V3 | Forme des événements json | Un `session` d'en-tête (`version: 3`, `id`, `cwd`), puis les événements de `AgentSessionEvent` tels quels, sauf `message_update` réduit à `{usage, assistantMessageEvent}`. `message_end.message` (rôle `assistant`) porte `content[]` (`text`, `thinking`, `toolCall`), `usage` (`input`, `output`, `cacheRead`, `cacheWrite`, `reasoning?`, `totalTokens`, `cost{…}`), `stopReason`, `errorMessage?`, `model`, `provider`. `tool_execution_start` = `{toolCallId, toolName, args}` ; `tool_execution_end` = `{toolCallId, toolName, result, isError, durationMs?}`. **Reste à capturer** : les fixtures réelles (`tests/fixtures/pi/*.jsonl`), ce qui demande un provider connecté — Ollama local suffit. | `modes/json-event.ts`, `modes/print-mode.ts`, `core/agent-session.ts`, `packages/ai/src/types.ts` |
| V4 | `PI_CODING_AGENT_SESSION_DIR` honoré ? nom des fichiers ? | **Oui** (`ENV_SESSION_DIR`, surchargé par `--session-dir`). Dossier par défaut `~/.pi/agent/sessions/--<cwd avec / \ : remplacés par ->--/`, fichier `<timestamp>_<id>.jsonl` (les `:` et `.` du timestamp deviennent `-`). | `config.ts` : `ENV_SESSION_DIR` ; `core/session-manager.ts` : `getDefaultSessionDirPath` |
| V5 | Reprendre par chemin ou par id ? | **Par id, sans chemin** : `--session <arg>` sans `/`, `\` ni `.jsonl` est cherché par id exact dans le `sessionDir` courant, puis par préfixe, puis dans tous les projets. Un UUID passe `_SAFE_OPTION_VALUE` ; aucun chemin n'entre en argv. | `main.ts` : `resolveSessionPath`, `findLocalSessionByExactId` |
| V6 | Lanceur Windows | Les deux existent : `pi.cmd` (npm, `bin` de `package.json`) et un binaire autonome (`install.ps1`, `pi-windows-x64.zip`). WorkPilot ne sait pas lequel est sur le PATH : **les contraintes de `validated_option` s'appliquent dans tous les cas**, et `build_windows_command` fait le reste pour le `.cmd`. | `packages/coding-agent/package.json`, `scripts/build-binaries.sh` |
| V7 | `--tools` : barrière réelle ? nom inconnu ? | **Allowlist réelle** : une liste de noms devient `allowedToolNames`, le filtre que `AgentSession` applique à tout outil, intégré ou d'extension (`createToolNameMatcher`) ; un outil hors liste n'existe pas pour le modèle. Un nom inconnu ne lève rien (il ne correspond à rien). Mélanger `name` et `+name`/`-name` **est** une erreur (`getToolListError`). Intégrés : `read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, `ls` ; défaut `read, bash, edit, write`. | `core/sdk.ts` (≈ l. 280), `core/agent-session.ts` (`_allowedTools`), `core/settings-manager.ts` |
| V8 | `--thinking` | Un niveau invalide est un **avertissement** et est ignoré ; un niveau que le modèle ne supporte pas est **ramené** au plus proche supporté (`clampThinkingLevel`), jamais une erreur ; sans modèle, `off`. | `cli/args.ts`, `core/sdk.ts`, `packages/ai/src/models.ts` |
| V9 | Projet non approuvé en mode json : silence ? | **Oui, silence total.** Ordre : `--approve`/`--no-approve` → événement `project_trust` d'une extension (utilisateur) → `trust.json` (entrée la plus proche en remontant les parents) → `defaultProjectTrust` (`ask` par défaut) → sans UI, **`false`**, sans diagnostic ni ligne sur stderr. Et la question ne se pose que si le projet a quelque chose à approuver : `.pi/{settings.json, mcp.json, extensions, skills, prompts, themes, SYSTEM.md, APPEND_SYSTEM.md}` ou un `.agents/skills/` dans `cwd` ou un parent. | `core/project-trust.ts` : `resolveProjectTrusted` ; `core/trust-manager.ts` : `hasTrustRequiringProjectResources` |
| V10 | `-ne` et `builtin:mcp` | `-ne` ne garde que les `-e` de la ligne de commande ; les intégrés (`builtin:mcp`, `llama.cpp`, `codemode`, `tool-search`) font partie des extensions découvertes, donc **tombent avec `-ne`** ; **`-e builtin:mcp` les rétablit un par un**. `--no-mcp` seul = `disabledBuiltinExtensions: ["mcp"]`. | `core/resource-loader.ts` (≈ l. 578), `core/package-manager.ts` (≈ l. 975-1005), `main.ts` |
| V11 | `trust.json`, `mcp.json` | `trust.json` = `{ "<chemin canonique>": true \| false }` ; lecture par **ancêtre le plus proche** (`findNearestTrustEntry`), écriture sous verrou (`proper-lockfile`), chemins passés par `realpath`. Conséquence utile : **approuver la racine du projet couvre ses worktrees** sous `.workpilot/worktrees/`. `mcp.json` n'est écrit que par `/mcp` et `pi mcp add`, jamais pendant un run : `_connect_json` convient. | `core/trust-manager.ts`, `extensions/mcp/index.ts` |
| V12 | Code de sortie en mode json | **0 même sur `stopReason: error`** : seul le mode `text` met `exitCode = 1` sur `error`/`aborted`/`length` ; `1` si l'invocation lève ; `143`/`129` sur SIGTERM/SIGHUP. L'adaptateur lit `stopReason`. | `modes/print-mode.ts` : `runPrintMode` |

**Deux décisions que ces réponses changent** (reportées au § 5.2) :

1. **Les skills du projet passent par `--skill`, pas par la confiance.** V2 et V9 ensemble : la
   confiance de pi garde deux choses de nature différente — des skills (de la prose que le modèle
   lit) et des extensions (du code qui s'exécute dans le processus). WorkPilot sert déjà
   `.agents/skills/` du projet cible à ses agents sur tous les providers (`slash_commands/api.py`,
   le SDK) ; ne pas les donner à pi serait une régression propre à ce provider, et `--approve` pour
   les obtenir ouvrirait aussi `.pi/extensions/`. `--skill .agents/skills` (relatif au `cwd`) donne
   exactement les skills, rien d'autre, avec le standing qu'ils ont ailleurs. Les extensions, le
   `mcp.json` et les prompts du projet restent derrière `/trust`, décision de la personne.
2. **La reprise se fait par id.** V5 : `--session <uuid>` est résolu dans le `sessionDir` posé
   par `PI_CODING_AGENT_SESSION_DIR` ; aucun chemin en argv, aucun cas Windows à traiter.

**Fixtures, livrées** : `tests/fixtures/pi/*.jsonl` sont six flux **réels** de pi 1.3.0
(`VERSION`), capturés par `tests/fixtures/pi/capture.py` contre un serveur OpenAI-compatible
factice qui scripte une réponse par identifiant de modèle (`models.json` dans un
`PI_CODING_AGENT_DIR` temporaire, clé fictive `sk-test-0000`, aucun réseau). Les événements sont
ceux de pi, seuls les mots du modèle sont faux — c'est le contrat de l'adaptateur, pas celui du
LLM. Ce que ces captures ont appris en plus de la source :

- `message_start`/`message_end` arrivent aussi pour les rôles `system`, `user` et `toolResult` :
  l'adaptateur filtre sur `message.role == "assistant"`.
- Avec `PI_CODING_AGENT_SESSION_DIR`, le fichier de session est **directement** dans ce dossier
  (pas de sous-dossier `--cwd--`) ; un `--session-id` inconnu crée la session avec cet id, en
  prévenant sur stderr ; `--session <uuid>` la reprend (`resume-by-id.jsonl`, même id, un seul fichier).
- Une 401 du provider donne `stopReason: "error"`, `errorMessage: "401: {…\"code\":\"invalid_api_key\"}"`,
  **rien sur stderr, code de sortie 0** (`auth-error.jsonl`).
- Un modèle absent de `models.json` n'est **pas** refusé par pi (« Using custom model id », stderr) :
  c'est le provider qui tranche, et sa réponse arrive comme ci-dessus (`unknown-model.jsonl`).
- Sous `--tools read,grep,find,ls`, un appel `write` reçoit `Tool write not found` (`isError: true`)
  et aucun fichier n'apparaît (`readonly-write-refused.jsonl`) — la barrière de V7, observée.
- `agent_end.messages` rejoue toute la conversation (élidé dans les fixtures) ; l'adaptateur ne
  lit que `agent_settled`.

À chaque montée de version de pi : `python tests/fixtures/pi/capture.py`, relire le diff.

## 4. Lot 1 — pi comme harness, et comme agent du cerveau (livré)

Aucun provider encore : ce lot rend pi **connu** du dépôt et du cerveau, à l'identique de hermes.
Livré tel que décrit ci-dessous ; les sorties de skills n'ont pas bougé (`skills:check` : 485
fichiers à jour, `agnostic` + `gemini`), `connect(root, "pi")` écrit `mcpServers` dans
`~/.pi/agent/mcp.json` sur `--apply` seulement, et `$PI_AGENT_DIR/` suit `PI_CODING_AGENT_DIR`.

### 4.1 `capabilities/harnesses.yaml` — entrée `pi`

```yaml
pi:
  skills_path: .agents/skills       # lu nativement (spec Agent Skills) ; rien n'est émis
  agents_path: null                 # pas de sous-agents natifs ; l'exemple `subagent/` lit .pi/agents/*.md (lot 5)
  commands_path: null               # les prompt templates (.pi/prompts/*.md) ne sont pas générés (lot 5)
  format: skill-dir
  instruction_file: AGENTS.md       # lu depuis cwd et ses parents, et depuis ~/.pi/agent ; CLAUDE.md aussi (V1)
  subagents: none
  hooks: .pi/extensions             # les hooks de pi sont des extensions TS (événements tool_call, before_agent_start…)
  mcp: .pi/mcp.json                 # projet, soumis à la confiance ; ~/.pi/agent/mcp.json côté utilisateur
  default: false
  note: >-
    Listed because it is supported, emitting nothing because pi already reads what this repo
    builds: `.agents/skills/` (and `.pi/skills/`) at cwd and its ancestors, and AGENTS.md.
    Project resources load only once the checkout is trusted (`/trust` in pi, saved in
    `~/.pi/agent/trust.json`, or `--approve` per process). In json/rpc mode there is no prompt
    and an untrusted project silently gets none — the provider adapter reports that state.
    Nothing here can or should grant it: a trusted project's `.pi/extensions/*.ts` run inside
    the pi process.
  tools:
    # pi's own tool names (packages/coding-agent docs, "tools"). `find` is the glob-style
    # file finder; there is no separate glob tool. `ls` has no canonical counterpart.
    Read: read
    Write: write
    Edit: edit
    Bash: bash
    Grep: grep
    Glob: find
```

Ce `tools:` est **la** table que le lot 2 lit pour construire `--tools` : une seule source pour
« comment pi appelle `Write` », déjà exploitée par `Harness.translate_tools` et par
`learning_loop/hermes_ingest` pour la portabilité d'un candidat.

**Preuve que rien ne casse** : `pnpm run skills:build` puis `pnpm run skills:check` → aucun diff
(`default: false`, pas d'`agents_path`). `skills_registry/harnesses.py` ne change pas : `pi` entre
dans `load_harnesses` comme les autres, et `detect_harnesses` le déclare présent quand `.pi/`
existe sur disque.

### 4.2 `brain/agents.py` — pi dans la table des agents

```python
AgentSpec(
    name="pi",
    label="pi",
    global_memory=("$PI_AGENT_DIR/AGENTS.md",),
    project_memory=("AGENTS.md",),            # pi has no project file of its own; .pi/APPEND_SYSTEM.md is a prompt, not a memory
    bridge_file="$PI_AGENT_DIR/AGENTS.md",
    supports_import=False,                    # no @path import: the bridge block lists the instructions inline
    mcp_config="$PI_AGENT_DIR/mcp.json",      # json, key `mcpServers` — the default format
    notes="PI_CODING_AGENT_DIR overrides ~/.pi/agent; trust.json gates project resources, never written here",
)
```

- `AgentSpec.resolve` apprend le préfixe `$PI_AGENT_DIR/` à côté de `$HERMES_HOME/` : `PI_CODING_AGENT_DIR`
  s'il est posé, sinon `~/.pi/agent` (même sous Windows : pi n'utilise pas `LOCALAPPDATA`
  **[à vérifier en V11]**).
- `brain/connect.py` : format `json`, clé `mcpServers`, l'entrée `workpilot-brain` de
  `server_entry` convient telle quelle (`command`, `args`, `env`). Si V11 montre que pi réécrit
  `mcp.json` en tournant, préférer `pi mcp add workpilot-brain -- python …` comme on préfère
  `claude mcp add-json` (`_connect_claude_cli`) ; sinon `_connect_json`, avec sa sauvegarde.
- `brain/memories.py` (`ingest`/`bridge`) : rien à écrire, la table suffit ; vérifier qu'un
  `~/.pi/agent/AGENTS.md` absent est **signalé absent, jamais créé** hors `--apply`.
- Le serveur MCP `workpilot-code` (`harness/tools/code_search_mcp.py`) documente déjà la ligne
  `claude mcp add …` ; ajouter l'équivalent `pi mcp add workpilot-code -- python apps/backend/runners/code_search_mcp.py --project-dir .`
  dans sa docstring et dans `docs/CONFIGURATION.md`.

### 4.3 Hermes : rien à modifier, une chose à dire

Les deux lisent les mêmes fichiers (`.agents/skills/`, `AGENTS.md`), chacun derrière sa propre
barrière de confiance (`hermes skills trust` ↔ `/trust`). Ni l'un ni l'autre n'est écrit par ce
dépôt. `hermes.md` reçoit un paragraphe « pi » qui le dit, et le tableau **Portability** d'un
candidat hermes gagne la colonne pi gratuitement par `harnesses.yaml` (`hermes_ingest` lit déjà la
matrice). Le pack `skills/hermes` (vendorisé, amont) n'est pas touché : une procédure « piloter pi »
écrite par nous irait dans `skills/tooling/pi` (lot 5), jamais dans un pack amont.

### 4.4 Tests du lot 1

- `tests/test_skills_registry_targets.py` / `test_skills_registry_agents.py` : `pi` chargé,
  `translate_tools(["Read","Write","Edit","Bash","Grep","Glob","Task"])` → noms pi, `Task` reporté
  comme non traduit (l'échec honnête que la matrice décrit).
- `tests/test_brain_*.py` : `agent("pi")`, `resolve("$PI_AGENT_DIR/x")` avec et sans
  `PI_CODING_AGENT_DIR`, `connect(root, "pi")` en aperçu (rien n'est écrit) et `--apply` (bloc écrit,
  `.bak` créé, JSON existant préservé).
- `tests/test_docs_context.py` : la ligne `pi.md` dans `docs/CLAUDE.md`.

### 4.5 Documentation du lot 1 (obligatoire, cf. préférence du dépôt)

| Fichier | Changement |
|---|---|
| `docs/architecture/pi.md` (ce fichier) | « à faire » du lot 1 → « livré » |
| `docs/CLAUDE.md` | ligne dans le tableau *Justifications de conception* (vérifié par `test_docs_context.py`) |
| `AGENTS.md` racine | « Claude Code, Codex, Copilot, Cursor, Gemini, OpenCode, Amp, hermes, **pi**… » ; ligne harness dans le tableau skills |
| `README.md` | la liste des harness lus, la liste des agents du cerveau |
| `docs/architecture/hermes.md`, `docs/architecture/brain.md` | paragraphe pi ; ligne dans la table des agents |
| `docs/CONFIGURATION.md` | `pi mcp add …` pour `workpilot-brain` et `workpilot-code` ; `PI_CODING_AGENT_DIR` |
| `docs/README.md` | carte : `integrations/pi.md` (guide utilisateur, lot 2) |
| `skills/README.md`, `.workpilot/skills.toml` (commentaire `harnesses`) | pi dans la liste des harness |
| `docs/audit/AUDIT-NETTOYAGE.md` | nouvelle annexe datée « ce qui a changé » + inventaire (`capabilities/`, `brain/agents.py`) |
| `docs/audit/WorkPilot-architecture.html` | nœud « Agents externes » (`Claude Code · Codex · hermes · Gemini… · pi`), section 02 (table des agents du cerveau) |
| `CHANGELOG.md` `[Unreleased]` | entrée *Nouveautés* |

## 5. Lot 2 — pi comme provider, mode `--mode json` (une invocation par turn) (livré)

Le cœur. Même frontière qu'OpenCode : processus par turn, prompt sur stdin, JSONL en sortie, le
CLI possède ses outils, sa session et sa connexion. Livré tel que décrit ci-dessous, avec trois
précisions prises en l'écrivant :

- **L'allowlist nomme aussi les outils MCP** des serveurs que le type déclare
  (`get_required_mcp_servers` → `mcp_tools_for_servers`), dans la graphie de pi
  (`mcp__<serveur>__<outil>`, tout autre caractère remplacé par `_`). pi n'expose par défaut
  les outils MCP qu'à son bac à sable `codemode`, que l'allowlist n'accorde pas ; `brain connect`
  écrit donc l'entrée `workpilot-brain` avec `"exposure": "direct"` (`AgentSpec.mcp_extras`).
- **Un id de session est un id** (`^[A-Za-z0-9-]{8,64}$`) : pi lit `--session` comme un chemin
  dès qu'il contient `/`, `\` ou finit en `.jsonl`, et écrit `--session-id` dans un nom de
  fichier. `_SAFE_OPTION_VALUE`, qui admet `.` et `/`, ne suffisait pas (S4).
- **Un modèle inconnu n'est pas refusé par pi** mais par le fournisseur, en `stopReason: error` ;
  le retry sur « default » se déclenche sur ce message, comme OpenCode.

`qualify_provider_model` (`cli_subprocess.py`) est désormais partagé avec OpenCode. Guide
utilisateur : [`../integrations/pi.md`](../integrations/pi.md).

### 5.1 `capabilities/providers.yaml`

```yaml
pi:
  adapter: PiCliAgentClient
  subagents: none
  effort: reasoning_effort       # --thinking off|minimal|low|medium|high|xhigh|max (V8)
  degrades_to: null
  context:
    compact: emulated            # pi compacts on its own inside a run (compaction.enabled); json mode has no
    usage: reported              # on-demand compact → lot 3 (rpc `compact`) flips this to native
  note: >-
    `pi --mode json` with the prompt on stdin. Tool rights are an allowlist (`--tools`) derived
    from the agent type's declaration through capabilities/harnesses.yaml `pi.tools`: a type
    declaring none of Write/Edit/Bash runs with `read,grep,find,ls` only. Sessions are kept in
    the task's spec directory (PI_CODING_AGENT_SESSION_DIR). Project resources (skills,
    extensions, .pi/mcp.json) load only if the person trusted the checkout in pi; the adapter
    reports the state in the task feed and never approves on their behalf.
```

### 5.2 `core/agent_clients/pi_cli.py` — `PiCliAgentClient(CliSubprocessAgentClient)`

**Commande** (`build_pi_args`, sans shell, le prompt n'y entre jamais) :

```
pi --mode json [--session-id <uuid> | --session <uuid>] [--model provider/id] [--thinking <level>]
   --tools <allowlist> --skill .agents/skills
```

| Décision | Pourquoi |
|---|---|
| Prompt système + historique rejoué en **préambule stdin**, comme OpenCode (`_take_prompt`) | V6 : un chemin absolu Windows ne passe pas `_SAFE_OPTION_VALUE` ; `--append-system-prompt <chemin relatif>` est l'amélioration du lot 3 (préfixe stable pour le cache, harness lot 2) |
| `--tools` construit depuis `declared_tools(agent_type)` traduits par `harnesses.yaml` `pi.tools` ; `ls` ajouté dès que `Read` est déclaré ; type non enregistré → pas de `--tools` (permissif, comme `ToolExecutor`) | une seule source de vocabulaire ; un type en lecture seule devient **réellement** incapable d'écrire (V7), là où Antigravity refuse et OpenCode fait confiance à `plan` |
| `powershell` jamais ajouté | un deuxième shell que l'allowlist de commandes ne voit pas |
| Session : `PI_CODING_AGENT_SESSION_DIR=<spec_dir>/pi-sessions` dans `_subprocess_env` ; `--session-id <uuid4>` au premier turn ; `--session <le même uuid>` ensuite, résolu par id exact dans ce dossier (V5) | les sessions d'une tâche sont un artefact de la tâche, ignoré par git ; aucun chemin en argv (V4, V5, V6) |
| Skills du projet : `--skill .agents/skills` (relatif au `cwd`, V2) quand le dossier existe ; jamais `--approve` | les skills ont sur pi le standing qu'ils ont sur les autres providers ; les extensions, `mcp.json` et prompts du projet restent derrière `/trust` (§ 3, décision 1) |
| Modèle : `qualify_provider_model` extrait de `resolve_opencode_model` vers `cli_subprocess.py` (même table `_PROVIDER_BY_PREFIX`, même repli « default ») | OpenCode et pi prennent tous deux `provider/model` ; une fonction, deux appelants |
| `--thinking` depuis `thinking_level_from_budget(max_thinking_tokens)` quand le résultat est un niveau que pi connaît ; sinon rien | comme Antigravity ; un budget custom (`"12000 tokens"`) n'est pas un niveau |
| **Jamais `--approve`.** Avant le spawn, `pi_trust_state(project_dir)` lit `~/.pi/agent/trust.json` (V11 : entrée la plus proche en remontant les parents, chemins résolus par `Path.resolve()`) : `trusted` / `untrusted` / `undecided`. Si le projet a un `.pi/` avec extensions, `mcp.json` ou prompts et n'est pas approuvé → une ligne dans le feed de tâche : « pi n'a pas chargé `.pi/` de ce projet : lancer `pi` dans le checkout puis `/trust` ». Les skills, eux, sont déjà passés par `--skill`. | le silence de V9, rendu visible ; la décision reste à la personne (hermes.md) |
| `--no-mcp` **non** passé | les serveurs de l'utilisateur sont les siens ; `workpilot-brain`/`workpilot-code` arrivent par `brain connect` (lot 1) |
| Erreurs : `message_end.message.stopReason == "error"` ou `"aborted"` → `PiCliError` (le code de sortie est 0, V12) ; `errorMessage` passé par `safe_error_text` ; marqueurs d'auth (`unauthorized`, `invalid api key`, `authentication`, `no api key`) → `PiCliAuthenticationError` nommant la réparation (`pi` puis `/login`, ou la variable d'environnement du provider) ; modèle inconnu → un retry sur « default », comme OpenCode | `_opencode_error`, à l'identique |
| `stopReason == "length"` | `PiCliError` explicite : la réponse est partielle, ne pas la logger comme un succès |

**Flux d'événements lus** (V3) :

| Événement pi | Ce qu'en fait l'adaptateur |
|---|---|
| `session` (en-tête, `id`) | `session_id` / `last_session_id` |
| `message_end` avec `message.role == "assistant"` | blocs `text` → `text_message(ASSISTANT, …)` ; `usage` → `last_usage` (`input + cacheRead + cacheWrite` = fenêtre occupée → `last_context_tokens`), `_record_call(from_pi_usage(usage))` ; `stopReason` (ci-dessus) |
| `message_update` | ignoré en lot 2 (pas de streaming vers l'UI) ; lot 3 |
| `tool_execution_end` (`toolCallId`, `toolName`, `args`, `result`, `isError`) | `tool_messages(...)` — informatif, rien n'est ré-exécuté |
| `compaction_end` | `context_usage_source` reste `reported` ; tracer « compacté par pi » dans le feed (le `guard` sait déjà lire une compaction native mid-turn) |
| `auto_retry_start`/`end` | tracés, pas d'action |
| `agent_settled` | fin de turn (pas `agent_end`, qui précède un éventuel retry) |

**Contrat de contexte** (duck-typé par `context_mgmt`) : `last_usage`, `last_session_id`,
`last_context_tokens`, `context_window_tokens = None` (inconnu en json ; lot 3), `context_usage_source`
= `reported` si un `usage` a été vu, sinon `estimated`.

**Harness de contexte** : `harness/domain/usage.py` gagne `from_pi_usage(usage)` à côté de
`from_step_tokens` ; `cost.total` de pi est **conservé comme information** et le ledger continue
de chiffrer lui-même (`harness/application/budget.py` prend déjà `vendor/model`) — deux chiffres
qui divergent sont une alerte utile, un seul serait invérifiable. `harness/application/tools.py`,
`subagents.py`, `replay.py` et `tests/harness/replay/profiles.json` : pi rejoint la liste des CLI
qui apportent leurs outils et envoient le prompt système en premier.

### 5.3 Branchement backend

| Fichier | Changement |
|---|---|
| `core/client.py` | `_normalize_provider_name` : `"pi": "pi"` ; les deux allowlists de providers (`AUTO_CLAUDE_PROVIDER`, `AI_PROVIDER=` du `.env` projet) ; la branche `elif provider in ("opencode", "antigravity")` devient `(…, "pi")` et instancie `PiCliAgentClient(model, system_prompt=cli_prompt, project_dir, agent_type, session_id=resume, thinking_level=…)` |
| `core/agent_client.py` | réexport `PiCliAgentClient`, `PiCliError`, `PiCliAuthenticationError` ; l'arbre ASCII en tête |
| `phase_config.py` | `PROVIDER_DEFAULT_MODELS["pi"]` = `CLI_DEFAULT_MODEL` sur les quatre phases |
| `core/auth.py` | `provider_requires_claude_oauth("pi") is False` (un test le dit) |
| `config/configured_providers.json` | `{ "name": "pi", "label": "pi (CLI)", "description": "Agent de code minimal et extensible piloté via la CLI pi, avec sa propre connexion aux fournisseurs." }` — `test_provider_capabilities` exige l'entrée dans `providers.yaml` |
| `workflows/` | rien : `subagents: none` est lu dans `providers.yaml` ; `tests/test_workflow_engine.py` paramétré ajoute `"pi"` à `["opencode", "antigravity", "meta"]` |
| `model_router/` | vérifier que le mode automatique traite `pi` comme `opencode` (modèle `default`, pas de tier) ; JEV n'y touche que par ce routeur |
| `integrations/jev` | **rien** ; un test prouve que `PiCliAgentClient._subprocess_env()` ne contient pas `TYPESAFE_API_KEY` quand le worker l'a retiré, et qu'un run JEV `bypass` n'empêche pas un build pi |

### 5.4 Frontend (Electron / React)

| Fichier | Changement |
|---|---|
| `shared/types/agent-cli.ts` | `AgentCliTool = "opencode" \| "antigravity" \| "pi"` ; `AGENT_CLI_EXECUTABLES.pi = "pi"` ; `AGENT_CLI_DOCS.pi = "https://pi.dev/docs/latest/cli"` ; `isAgentCliTool` |
| `main/ipc-handlers/agent-cli-handlers.ts` (+ `.test.ts`) | `pi --version` ; le lanceur `.cmd` passe par la couche `platform/`, jamais `process.platform` |
| `renderer/components/AgentCliStatusBadge.tsx`, `Sidebar.tsx` | badge `pi` ; libellés via `react-i18next` (`navigation.json` en **et** fr) — les libellés OpenCode codés en dur dans le badge sont à faire passer par i18n dans la même PR, puisqu'on touche le fichier |
| `shared/services/providerRegistry.ts` | `PI_MODELS` = `{ value: CLI_DEFAULT_MODEL, label: "pi default" }` + quelques `provider/model` ; `AGENT_CLI_PROVIDERS.add("pi")` |
| `shared/utils/provider-detection.ts` | type union, libellé |
| Réglages → Providers | pas de clé : pi possède sa connexion ; un lien « se connecter dans pi » (`openExternalUrl`, protocole en liste fermée) |

### 5.5 Tests du lot 2 (`tests/test_pi_cli_client.py`, calqué sur OpenCode)

Synchrones : commande sans shell et sans prompt ; `--session-id` au premier turn, `--session`
ensuite ; `--tools` d'un `coder` = `read,bash,edit,write,grep,find,ls` ; d'un type sans écriture =
`read,grep,find,ls` ; type inconnu = pas de `--tools` ; `powershell` jamais présent ; valeurs
d'option refusées (`validated_option`) ; modèle qualifié `provider/model` ; `--thinking` seulement
pour un niveau connu ; `pi_trust_state` sur les trois formes de `trust.json` (+ absent) ;
`create_agent_client` route `pi` ; jamais le jeton OAuth Claude ; défaut de phase = `default`.

Asynchrones (avec `_FakeProcess` et les fixtures du lot 0) : prompt sur stdin et événements
parsés en messages ; `usage` → `last_usage`/`last_context_tokens`/`reported` ; sans `usage` →
`estimated` ; `stopReason: error` avec code 0 → `PiCliError` expurgé ; auth → la commande de
réparation ; modèle rejeté → un retry sur default ; `length` → erreur explicite ; exécutable absent
→ message clair ; annulation (`CancelledError`) → processus terminé ; `PI_CODING_AGENT_SESSION_DIR`
posé et `TYPESAFE_API_KEY` absent de l'environnement du sous-processus.

Existants à étendre : `test_provider_capabilities.py` (`pi` dans « les CLI n'ont pas de
sous-agents », « chaque adaptateur nomme une classe réelle » passe seul), `test_workflow_engine.py`,
`tests/harness/test_usage.py` (`from_pi_usage`), frontend `agent-cli-handlers.test.ts`.

### 5.6 Documentation du lot 2

`docs/integrations/pi.md` (guide utilisateur : installer, `/login`, `/trust` dans le checkout,
choisir « pi (CLI) », ce que WorkPilot ne fait pas à sa place), `docs/CONFIGURATION.md`
(`AUTO_CLAUDE_PROVIDER` accepte `pi` ; le paragraphe « les clients CLI ne sont pas affectés » ;
variables), `docs/architecture/delegation.md` (ligne `none`), `context-management.md`,
`context-harness.md`, `apps/backend/AGENTS.md` (liste de `core/agent_clients/`),
`apps/backend/agents/README.md`, `README.md` (providers), `CHANGELOG.md`, et les deux fichiers
d'audit (`AUDIT-NETTOYAGE.md` : annexe ; `WorkPilot-architecture.html` : la ligne `none` de la
table des sous-agents, l'inventaire de `core/agent_clients/`).

## 6. Lot 3 — Mode RPC : un processus par session, compaction à la demande

Ce que le mode json ne peut pas donner et que le harness de contexte veut :

| Capacité | RPC | Effet dans WorkPilot |
|---|---|---|
| `compact {customInstructions?}` | oui | `providers.yaml` `context.compact: native` ; `context_mgmt/decide.py` laisse pi compacter sous le seuil dur, comme Codex |
| `abort` | oui | `BuildPaused` / `BuildHalted` / annulation → `abort` puis fermeture de stdin, au lieu de `terminate()` |
| `get_state` (`isStreaming`, `isCompacting`, `messageCount`, `sessionFile`) | oui | jauge et reprise exactes |
| `set_model`, `set_thinking_level` | oui | changement de phase sans relancer le processus |
| `steer` / `follow_up` | oui | hors périmètre (la boucle WorkPilot n'a pas de steering) — noté, pas câblé |
| `extension_ui_request` (`select`, `confirm`, `input`…) | arrive si une extension pose une question | **toujours** répondu `{"cancelled": true}` : un run sans UI ne demande rien à personne ; tracé dans le feed pour que l'extension soit identifiée |

**Forme.** Même classe, un mode : `PiCliAgentClient(mode="json"|"rpc")`, choisi par
`WORKPILOT_PI_MODE` (défaut `json` tant que le lot 3 n'est pas sorti de l'expérimentation, puis
`rpc`). Le processus vit le temps du `async with client:` ; `receive_response` envoie `prompt` et
lit jusqu'à `agent_settled`. `--append-system-prompt .workpilot/specs/<spec>/pi/system.md`
(chemin relatif, V6) remplace le préambule stdin : le prompt système devient un préfixe stable
d'un turn à l'autre (harness, lot 2 : « du plus stable au plus volatil »).

Tests : protocole `id`/`response` ; `agent_settled` et non `agent_end` ; `abort` sur annulation ;
`extension_ui_request` → `cancelled` ; `compact` déclenché par `context_mgmt` et `compaction_end`
lu ; un processus qui meurt entre deux turns → erreur claire, pas un blocage.

## 7. Lot 4 — Parité des garde-fous (à décider après le lot 2, options écrites)

Sur le SDK Claude, les hooks `PreToolUse` de `create_client()` sont la barrière (allowlist de
commandes, écritures confinées, watermarks, `read_guard`). Sur OpenCode et Antigravity, WorkPilot
s'appuie sur le worktree isolé et les droits du CLI ; c'est l'état documenté
(`agent-tool-rights.md`). pi offre, en plus, un point d'accroche que les autres CLI n'ont pas :
l'événement `tool_call` d'une extension peut **bloquer** (`{ block: true, reason }`) et modifier
`event.input`.

| Option | Ce qu'elle donne | Ce qu'elle coûte |
|---|---|---|
| **A — parité CLI** (défaut après lot 2) : `--tools` + worktree, rien d'autre | même standing qu'OpenCode ; zéro code TS | `bash` sans allowlist, écritures hors projet possibles si le modèle le veut |
| **B — extension `workpilot-guard.ts`** écrite par WorkPilot dans `<spec>/pi/` avant le spawn, chargée par `-e .workpilot/specs/<spec>/pi/workpilot-guard.ts` (relatif, V6) : chemins d'écriture confinés au `cwd`, `<spec>` et `<tmp>/workpilot` (port de `protected-paths.ts`), denylist de commandes miroir de `security/command_registry` (pas l'allowlist complète : ses validateurs sont en Python) | la première vraie barrière sur un CLI | du TypeScript à maintenir en face du Python ; **n'est pas** l'allowlist (un miroir partiel qui prétend l'être est le genre de demi-vérité que `providers.yaml` existe pour finir) |
| **C — l'extension interroge le backend** (`127.0.0.1:9000`, route avec permission) pour chaque `bash` | l'allowlist réelle, les validateurs réels | latence par outil ; une route de plus à garder (S5) ; dépendance du processus pi au backend |

Recommandation : A au lot 2 (dit tel quel dans `agent-tool-rights.md`), B si un incident ou une
revue le demande, C seulement si B s'avère insuffisant. Les watermarks restent hors de pi : le
retrait se fait côté Python sur les fichiers du worktree à la fin du turn, comme pour les
providers hors SDK (`watermarks.md`).

## 8. Lot 5 — Confort (chacun indépendant, aucun requis)

- **Sous-agents** : `agents_path: .pi/agents` + l'extension d'exemple `subagent/` ; les définitions
  du registre (`agents/subagents/`) émises avec `translate_tools` — `Task` reste non traduit et le
  build le dit. `subagents` reste `none` dans `providers.yaml` tant que WorkPilot ne lit pas ce
  que l'extension fait.
- **Prompt templates** : `.pi/prompts/<skill>.md` générés depuis les skills, comme
  `.gemini/commands/*.toml` (`format: prompt-template`) — utile seulement si `/skill:name` ne suffit
  pas à quelqu'un.
- **Catalogue de modèles** : `pi --list-models` → `pi_models.py` à côté de `codex_models.py`, servi
  au sélecteur à la place de la liste statique de `providerRegistry.ts`.
- **`skills/tooling/pi`** : la procédure « piloter pi sans UI » (json, rpc, trust) pour les agents
  qui en auraient besoin, au format portable (noms canoniques, table de traduction).
- **Doctor Kanban** : une carte « pi » (installé, version, trust du checkout, MCP `workpilot-brain`
  présent dans `~/.pi/agent/mcp.json`), calquée sur `HermesLearningCard` mais sans cycle —
  rendue seulement si pi est installé.

## 9. Commandes de vérification (chaque lot)

```bash
pytest tests/ -v                                   # dont test_pi_cli_client, test_provider_capabilities, test_docs_context, test_brain*, test_skills_registry_*
pnpm test && pnpm run lint && pnpm run typecheck   # frontend (lot 2+)
pnpm run skills:build && pnpm run skills:check     # aucun diff : pi n'émet rien
ruff check apps/backend tests src && ruff format --check apps/backend tests src   # ruff 0.15.7
python scripts/check_encoding.py
python scripts/generate_model_catalog.py --check   # si le lot touche un catalogue
```

Avant la PR : la liste « avant d'ouvrir une PR qui touche une frontière » de
`docs/rules/security.md` (le lot 2 touche une frontière : un sous-processus avec les droits de
l'utilisateur) ; aucun secret dans `tests/fixtures/pi/` ; i18n `en` **et** `fr` ; les README et
les deux fichiers de `docs/audit/` mis à jour dans la même PR.

## 10. Risques et questions ouvertes

| Risque | Mitigation |
|---|---|
| pi remonte `AGENTS.md` jusqu'à la racine du disque (V1) : un `AGENTS.md` dans `C:\Repositories\` ou `~` entre dans le prompt | documenté dans `integrations/pi.md` ; c'est le comportement de pi pour tout projet, pas un défaut de WorkPilot |
| Le flux json change entre deux versions de pi (1.x bouge vite : `session.version: 3`) | fixtures versionnées, `pi --version` tracé dans le feed, tolérance aux champs inconnus (ignorer, ne pas lever) ; les réponses du § 3 citent le fichier source pour être revérifiées à chaque montée de version |
| `trust.json` : chemins canoniques, casse Windows, liens symboliques | `Path.resolve()` des deux côtés avant comparaison (S4) ; test Windows en CI |
| Un `.pi/extensions/*.ts` du projet cible s'exécute si la personne a approuvé le checkout | c'est sa décision, documentée dans `integrations/pi.md` ; WorkPilot ne l'étend jamais (`--approve` interdit par un test) |
| Node 22.19 requis par pi, absent de la machine | détecté par `pi --version` (badge) ; message qui renvoie à pi.dev, pas une installation silencieuse |
| Coût : pi facture aussi via son propre `cost.total` | conservé en parallèle du ledger, jamais substitué |

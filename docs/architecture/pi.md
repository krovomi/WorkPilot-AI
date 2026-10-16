# pi (pi.dev) — plan d'intégration par lots

> **Statut : plan, rien n'est livré.** Un lot = une PR vers `develop`. Les lots sont ordonnés par
> dépendance, jamais par durée (règle 11 de `docs/CLAUDE.md`). Ce fichier devient la justification
> de conception de la feature (`docs/architecture/`, une ligne dans `docs/CLAUDE.md`) ; chaque lot
> livré remplace sa section « à faire » par ce qui a été fait, comme `context-harness.md`.
>
> Faits sur pi relevés le 16 octobre 2026 sur pi.dev/docs/latest et le dépôt
> `earendil-works/pi` (npm `@earendil-works/pi-coding-agent` **1.3.0**). Ce qui est marqué
> **[à vérifier]** n'a pas pu être confirmé dans la documentation et se vérifie au lot 0, contre
> le binaire installé, avant d'écrire une ligne de produit.

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

**À vérifier, dans l'ordre, chacun avec sa preuve consignée dans ce fichier :**

| # | Question | Pourquoi ça compte | Comment |
|---|---|---|---|
| V1 | Dans un dossier qui a `AGENTS.md` **et** `CLAUDE.md`, pi charge-t-il les deux ou le premier trouvé ? | `CLAUDE.md` ici est trois lignes `@import` que pi ne développe pas ; si pi ne lit que `CLAUDE.md`, il ne voit **rien** des règles | `pi --mode json -p "quote the first heading of your context files"` à la racine ; comparer avec `-nc` |
| V2 | `--skill <path>` accepte-t-il un **dossier** (découverte récursive) ou un seul `SKILL.md` ? | décide si un projet non approuvé peut recevoir `.agents/skills/` explicitement | essai avec `--skill .agents/skills` |
| V3 | Forme exacte des événements `--mode json` : `message_end.message.usage` (`input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`, `cost.total`), `stopReason`, `errorMessage`, `tool_execution_end.result` | c'est le contrat de `receive_response` | capturer un run avec un outil, un run en erreur d'auth, un run avec modèle inconnu → `tests/fixtures/pi/*.jsonl` |
| V4 | `PI_CODING_AGENT_SESSION_DIR` est-il honoré en mode json, et le nom du fichier de session est-il `<timestamp>_<id>.jsonl` sous `--<cwd>--/` ? | les sessions d'une tâche doivent vivre dans `.workpilot/specs/<spec>/` (ignoré par git), pas dans `~/.pi` ; « sessions may contain secrets » | run avec la variable, lister le dossier |
| V5 | `--session <path>` reprend-il une session dont le fichier est hors du `sessionDir` courant ? | reprise d'un turn à l'autre | deux runs, le second avec `--session <fichier du premier>` |
| V6 | Lanceur Windows : `pi.cmd` (npm) ou `pi.exe` (install.ps1) ? `build_windows_command` ajoute `cmd.exe` pour `.cmd` ; `_SAFE_OPTION_VALUE` refuse alors `\`, espaces, `%` | tout chemin passé en option doit être relatif avec `/`, ou passer par l'environnement | `where pi` ; essai avec `--session-dir .workpilot/x` |
| V7 | `--tools read,grep,find,ls` refuse-t-il réellement `edit`/`write`/`bash` (l'outil n'existe pas pour le modèle, pas seulement « déconseillé ») ? Un nom inconnu dans `--tools` est-il une erreur ? | la barrière de droits des types en lecture seule | run avec un prompt qui demande d'écrire un fichier ; vérifier qu'aucun fichier n'apparaît |
| V8 | `--thinking` : valeurs acceptées par modèle (`off\|minimal\|low\|medium\|high\|xhigh\|max`) ; comportement sur un modèle sans réflexion (erreur ou ignoré ?) | `effort: reasoning_effort` dans `providers.yaml` | essais |
| V9 | Avec `trust.json` sans entrée pour le projet et sans `--approve`, les skills de `.agents/skills/` sont-ils absents du prompt système ? Y a-t-il une trace sur stderr ? | confirme le silence que le lot 2 doit rendre visible | run json, lire stderr |
| V10 | `-ne` (no extensions) retire-t-il aussi `builtin:mcp` ? `-e builtin:mcp` après `-ne` le rétablit-il ? | le lot 3/4 décide si WorkPilot peut n'autoriser **que** le MCP intégré | essais |
| V11 | Forme de `~/.pi/agent/trust.json` (clés, chemins canoniques, casse sous Windows) et de `~/.pi/agent/mcp.json` ; pi réécrit-il `mcp.json` pendant qu'il tourne (comme Claude Code avec `~/.claude.json`) ? | `brain/agents.py` + `brain/connect.py` | lire les fichiers après `/trust` et `pi mcp add` |
| V12 | Codes de sortie en mode json : confirmé « non nul seulement si l'invocation lève » ; donc une réponse `stopReason: error` sort à 0 | l'adaptateur doit lire `stopReason`, pas le code | run avec clé invalide |

**Livrables du lot 0.** Ce fichier complété (faits, pas suppositions), `tests/fixtures/pi/` (flux
capturés, secrets masqués par `safe_error_text` avant commit — le hook `pre-commit` scanne), et
une décision écrite sur V1 : si pi ne lit que `CLAUDE.md` quand les deux existent, le lot 1
ajoute à `CLAUDE.md` une ligne qui renvoie **humainement** vers `AGENTS.md` (« si tu ne développes
pas `@import`, lis `AGENTS.md` »), ce qui ne coûte rien à Claude Code et sauve tout harness qui
préfère `CLAUDE.md`.

## 4. Lot 1 — pi comme harness, et comme agent du cerveau

Aucun provider encore : ce lot rend pi **connu** du dépôt et du cerveau, à l'identique de hermes.

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

## 5. Lot 2 — pi comme provider, mode `--mode json` (une invocation par turn)

Le cœur. Même frontière qu'OpenCode : processus par turn, prompt sur stdin, JSONL en sortie, le
CLI possède ses outils, sa session et sa connexion.

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
pi --mode json [--session <file>|--session-id <uuid>] [--model provider/id] [--thinking <level>]
   --tools <allowlist> [--no-approve]
```

| Décision | Pourquoi |
|---|---|
| Prompt système + historique rejoué en **préambule stdin**, comme OpenCode (`_take_prompt`) | V6 : un chemin absolu Windows ne passe pas `_SAFE_OPTION_VALUE` ; `--append-system-prompt <chemin relatif>` est l'amélioration du lot 3 (préfixe stable pour le cache, harness lot 2) |
| `--tools` construit depuis `declared_tools(agent_type)` traduits par `harnesses.yaml` `pi.tools` ; `ls` ajouté dès que `Read` est déclaré ; type non enregistré → pas de `--tools` (permissif, comme `ToolExecutor`) | une seule source de vocabulaire ; un type en lecture seule devient **réellement** incapable d'écrire (V7), là où Antigravity refuse et OpenCode fait confiance à `plan` |
| `powershell` jamais ajouté | un deuxième shell que l'allowlist de commandes ne voit pas |
| Session : `PI_CODING_AGENT_SESSION_DIR=<spec_dir>/pi-sessions` dans `_subprocess_env` ; `--session-id <uuid4>` au premier turn ; `--session <fichier>` ensuite (`validated_option` : le chemin est relatif au `cwd`, en `/`) | les sessions d'une tâche sont un artefact de la tâche, ignoré par git ; aucun chemin absolu en argv (V4, V5, V6) |
| Modèle : `qualify_provider_model` extrait de `resolve_opencode_model` vers `cli_subprocess.py` (même table `_PROVIDER_BY_PREFIX`, même repli « default ») | OpenCode et pi prennent tous deux `provider/model` ; une fonction, deux appelants |
| `--thinking` depuis `thinking_level_from_budget(max_thinking_tokens)` quand le résultat est un niveau que pi connaît ; sinon rien | comme Antigravity ; un budget custom (`"12000 tokens"`) n'est pas un niveau |
| **Jamais `--approve`.** Avant le spawn, `pi_trust_state(project_dir)` lit `~/.pi/agent/trust.json` (V11) : `trusted` / `untrusted` / `undecided` ; `undecided` ou `untrusted` → une ligne dans le feed de tâche : « pi n'a pas chargé les skills du projet : lancer `pi` dans le checkout puis `/trust` » | le silence de V9, rendu visible ; la décision reste à la personne (hermes.md) |
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
| pi ne lit que `CLAUDE.md` quand les deux existent (V1) et perd donc les règles | ligne humaine dans `CLAUDE.md` (lot 0/1) ; au pire, `-nc` + `AGENTS.md` en préambule stdin |
| Le flux json change entre deux versions de pi (1.x bouge vite : `session.version: 3`) | fixtures versionnées, `pi --version` tracé dans le feed, tolérance aux champs inconnus (ignorer, ne pas lever) |
| `trust.json` : chemins canoniques, casse Windows, liens symboliques | `Path.resolve()` des deux côtés avant comparaison (S4) ; test Windows en CI |
| Un `.pi/extensions/*.ts` du projet cible s'exécute si la personne a approuvé le checkout | c'est sa décision, documentée dans `integrations/pi.md` ; WorkPilot ne l'étend jamais (`--approve` interdit par un test) |
| Node 22.19 requis par pi, absent de la machine | détecté par `pi --version` (badge) ; message qui renvoie à pi.dev, pas une installation silencieuse |
| Coût : pi facture aussi via son propre `cost.total` | conservé en parallèle du ledger, jamais substitué |

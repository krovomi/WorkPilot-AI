# Audit WorkPilot AI — cahier de nettoyage et d'optimisation

| | |
|---|---|
| **Commit audité** | `b46a031` (`develop`, après PR #292) — comparé à l'audit précédent sur `7057b28` |
| **Date** | 3 octobre 2026 |
| **Compagnon visuel** | [`WorkPilot-architecture.html`](WorkPilot-architecture.html) — schémas interactifs, simulateur Kanban, inventaire filtrable |
| **Objet** | Corriger les features cassées, supprimer le code mort et les doublons, réduire le coût en tokens et en mémoire, **sans retirer une seule feature utilisée** |

Ce document est un **cahier de tâches pour agents de code**. Chaque tâche est autonome : problème,
preuve (`fichier:ligne`), étapes, ce qu'il faut préserver, critères d'acceptation et commandes de
vérification. Les tâches sont regroupées en **lots** ; un lot = une PR vers `develop`. Les lots d'une
même priorité sont parallélisables sauf dépendance indiquée.

Tous les chemins backend sont relatifs à `apps/backend/`, tous les chemins frontend à
`apps/frontend/src/`, sauf mention contraire.

---

## 0. Mode d'emploi pour l'agent qui prend une tâche

### 0.1 Règles non négociables (reprises de `docs/CLAUDE.md`, qui fait foi)

- **PR vers `develop`**, jamais `main`. Un lot = une PR, titre `chore(cleanup): …` ou `fix(…): …`.
- **Claude Agent SDK uniquement** : jamais `anthropic.Anthropic()` ; toujours `create_client()` /
  `create_agent_client()` de `core.client`.
- **i18n** : tout texte visible passe par `react-i18next`, clés ajoutées (ou retirées) dans `en/*.json`
  **et** `fr/*.json`.
- **Abstraction plateforme** : jamais `process.platform` ; `main/platform/` ou `core/platform/`.
- **Versions d'outils épinglées** : ruff `0.15.7`, Biome `2.5.11`.
- **Pas d'estimation de durée** dans les PR ou la doc.
- Le provider d'un endpoint se lit avec `core.client.peek_active_provider`, jamais
  `_get_active_provider` (voir F13/F25).

### 0.2 Principe de suppression

1. **Prouver l'absence d'appelant avant de supprimer** (méthodes en §0.3). Une recherche textuelle ne
   suffit pas pour le frontend : confirmer avec `npx knip` (ou `npx ts-prune`) puis `pnpm run typecheck`.
2. **Une feature visible ne disparaît jamais en silence.** Si une page de la barre latérale est cassée
   (ex. F21), la tâche est « câbler **ou** retirer avec son entrée Sidebar, son store, son API preload,
   ses clés i18n et son runner » — et la PR le dit.
3. **Supprimer le test avec le code qu'il teste**, jamais un test qui couvre du code vivant.
4. **Migrer avant de supprimer** quand des appelants existent (shims, Graphiti).
5. Ne pas mélanger un nettoyage et un changement de comportement dans le même commit.

### 0.3 Méthodes de preuve utilisées par cet audit (réutilisables)

```bash
# Backend : agent_type utilisés mais non enregistrés (F1)
cd apps/backend && python3 - <<'EOF'
import ast, os, re
src = open('agents/tools_pkg/models.py').read()
keys = next([k.value for k in n.value.keys] for n in ast.walk(ast.parse(src))
            if isinstance(n, ast.Assign) and any(getattr(t, 'id', None) == 'AGENT_CONFIGS' for t in n.targets))
for root, dirs, files in os.walk('.'):
    if any(p in root for p in ('vendor', '__pycache__', 'tests')): continue
    for f in files:
        if f.endswith('.py'):
            s = open(os.path.join(root, f), encoding='utf-8').read()
            for m in re.finditer(r'agent_type\s*=\s*["\']([a-z_]+)["\']', s):
                if m.group(1) not in keys:
                    print(m.group(1), os.path.join(root, f), s[:m.start()].count('\n') + 1)
EOF

# Backend : un module a-t-il un importeur ? (remplacer NOM)
grep -rnE "^\s*(from|import) NOM(\.| |$)" --include=*.py apps/backend tests src scripts
grep -rn "NOM" apps/frontend/src --include=*.ts   # runners lancés par chemin

# Frontend : importeurs stricts d'un fichier (remplacer Base)
grep -rnE "(from|import\(|require\()\s*[\"'][^\"']*/Base(\.tsx?)?[\"']" apps/frontend/src \
  | grep -v -E "\.test\.|__tests__|__mocks__"

# Profil réel d'un build, par effort (F2, F15)
cd apps/backend && python3 -c "
import sys; sys.path.insert(0, '.')
from pathlib import Path
from workflows.spec import load_workflow
from workflows.engine import resolve_profile
wf = load_workflow(Path('../../workflows/feature-build/workflow.yaml'))
for e in ['none', 'low', 'medium', 'high', 'ultrathink']:
    print(e, [r.phase.id for r in resolve_profile(wf, effort=e, provider='claude').run])"

# Roster réellement servi (F5, F9)
cd apps/backend && python3 -c "
import sys; sys.path.insert(0, '.')
from agents.subagents import resolve
from agents.subagents.pr_review import pr_review_agents
ua = pr_review_agents(lambda n: 'x', lambda p, w=None: p)
print(sorted(resolve('pr_orchestrator_parallel', project_dir='.', user_agents=ua)))"
```

### 0.4 Vérifications avant chaque PR

```bash
# Backend
ruff check apps/backend/ tests/ src/ utils/ && ruff format --check apps/backend/ tests/ src/ utils/
pytest tests/ -q -x            # ou les fichiers ciblés indiqués dans la tâche
python3 scripts/skills_cli.py build --check   # si skills/ ou .workpilot/skills.toml change

# Frontend
cd apps/frontend && pnpm run typecheck && pnpm run lint && pnpm test
```

---

## 1. Vue d'ensemble des lots

| Lot | Priorité | Thème | Constats | Dépend de |
|---|---|---|---|---|
| L1 | P0 | Features cassées (backend) — **fait** | F1, F24 | — |
| L2 | P0 | Phase architecture-map — **fait** | F20 | L1 (test AST) conseillé |
| L3 | P0 | Features cassées (frontend) — **fait** | F21, F22 | — |
| L4 | P1 | Contexte de développement — **fait** | F23, F18 | — |
| L5 | P1 | Droits et rosters minimaux — **fait** | F4, F5, F9, F16 | L1 |
| L6 | P1 | Pipeline payé = pipeline exécuté — **fait** | F2, F3, F15, F35, F38 | — |
| L7 | P2 | Une seule mémoire | F6, F7, F14, F34 | L1 (insight_extractor) |
| L8 | P2 | Code mort frontend | F28, F25 (front) | L3 |
| L9 | P2 | Code mort backend | F29, F30, F32, F33, F25 (back) | — |
| L10 | P3 | Tokens à haut effort | F10, F11, F17 | L6 |
| L11 | P3 | Consolidation | F8, F26, F27, F31, F36 | L5 |
| L12 | P3 | Gouvernance | F12, F13 | L9 (F25) pour F13 |
| L13 | P4 | Surface produit | F19 | tous |
| L14 | P1 | Événements et appels IPC perdus en silence — **fait** | F37 | — |
| L15 | P1 | Droits effectifs et succès silencieux — **fait** | F39, F40 | L5 |
| L16 | P1 | Droits hors de `create_client` — **fait** | F41, F42, F43, F44, F45 (+ F46, F47) | L15 |
| L17 | P1 | Le self-healing ne revendique que ce qu'il fait — **fait** | F48 | — |

Ordre recommandé : L1, L2, L3, L6, L5, L14, L4, L15, L16, L17 (faits) → L7, L8, L9 → L10, L11, L12 → L13.

### Chiffres de référence (pour mesurer les gains)

| Mesure | Valeur à `b46a031` | Cible |
|---|---|---|
| `docs/CLAUDE.md` chargé à chaque session Claude Code | 268 Ko (~67 k tokens) | < 20 Ko |
| agent_types non enregistrés | 7 (0 après le lot L1) | 0 |
| Références Graphiti/LadybugDB hors `integrations/graphiti` | 214 (45 fichiers) | 0 |
| Fichiers frontend sans importeur de production | 57 (~16,5 k lignes) | 0 |
| Paquets/modules backend sans importeur | 3 paquets + 12 modules (~6,7 k lignes) | 0 |
| Shims racine `apps/backend/*.py` | 25 | 0 (hors points d'entrée) |
| Prompts orphelins | 11 (~51 Ko) | 0 |
| Phases du workflow à implémentation absente sur un clone | 5 (+ design-check sans SKILL.md) ; 0 après le lot L6 | 0 |
| Sous-agents du plus gros roster | 9 ; 7 après le lot L5 (6 pour l'orchestrateur de PR) | ≤ 7 |
| Sessions qui relisent le diff à ultrathink | jusqu'à 7 ; 5 après le lot L6 (adversarial-review et spec-conformance retirés) | ≤ 4 |
| Détecteurs de pile | ≥ 11 | 1 façade |
| Écritures par merge | 4 magasins | 1 événement |

---

## 2. Tâches détaillées

### Lot L1 — Features cassées côté backend (P0)

#### F1 · Sept features LLM échouent en silence : `agent_type` absent d'`AGENT_CONFIGS`

- **Sévérité** critique · **statut** ouvert depuis l'audit précédent · **vérifié** (reproduit)
- **Corrigé par le lot L1.** Les sept entrées sont dans `AGENT_CONFIGS`, gardées par
  `tests/test_agent_type_registry.py`. La correction a révélé un second défaut :
  `run_insight_extraction` (`analysis/insight_extractor.py`) lançait la session puis ne renvoyait
  rien, si bien que même un `agent_type` valide n'aurait jamais alimenté la mémoire ; elle renvoie
  désormais l'objet JSON lu par `spec.plan_recovery.extract_json_document`.
- **Preuve** : `get_agent_config("insight_extractor")` lève `ValueError: Unknown agent type`
  (`agents/tools_pkg/models.py:476-495`). Appelants :
  `agents/impact_analyzer.py:305`, `architecture/ai_reviewer.py:76`, `migration/llm_transformer.py:75`,
  `analysis/insight_extractor.py:379`, `learning_loop/service.py:110`,
  `context_mesh/mesh_service.py:266`, `live_companion/analyzer.py:122`. Les sept attrapent l'exception
  et journalisent un avertissement ; l'extracteur d'insights, seul écrivain prévu de
  `patterns/`, `codebase/` et `outcomes/` dans le vault, ne produit donc rien.
- **Étapes**
  1. Ajouter sept entrées dans `AGENT_CONFIGS` (`agents/tools_pkg/models.py`), en suivant le modèle
     des entrées voisines (`analyzer`, `insights`, `pr_reviewer`) :
     - `insight_extractor`, `learning_analyzer`, `context_mesh_analyzer`, `live_companion_analyzer` :
       `BASE_READ_TOOLS`, `mcp_servers: []`, `thinking_default: "low"`.
     - `impact_analyzer`, `architecture_reviewer` : `BASE_READ_TOOLS + WEB_TOOLS`,
       `mcp_servers: ["context7"]`, `thinking_default: "medium"` / `"high"`.
     - `migration` : lire `migration/llm_transformer.py` — si le modèle écrit lui-même les fichiers,
       `BASE_READ_TOOLS + BASE_WRITE_TOOLS` ; sinon lecture seule. `thinking_default: "medium"`.
  2. `PHASE_ALIASES` (`agents/subagents/phases.py:84`) les route déjà (sauf `migration` → ajouter
     `"migration": "solo"` ou `"kanban"` selon l'usage réel).
  3. Ajouter `tests/test_agent_type_registry.py` : parcourir l'AST de `apps/backend` (hors `vendor/`,
     tests), collecter chaque littéral `agent_type="…"` **et** chaque appel à `create_client` /
     `create_agent_client` / `create_agent_runtime`, et vérifier (a) que l'appel nomme un
     `agent_type`, (b) que celui-ci est une clé d'`AGENT_CONFIGS`. Ce test couvre aussi F24.
- **À préserver** : le comportement fonctionnel des sept features ; seules leurs permissions deviennent explicites.
- **Acceptation** : `get_agent_config` réussit pour les sept ; le nouveau test passe ; `tests/test_agent_configs.py`
  et `tests/test_subagents_coverage.py` passent (mettre à jour `test_known_agent_types_exist` si besoin).
- **Vérification** : `pytest tests/test_agent_configs.py tests/test_subagents_coverage.py tests/test_agent_type_registry.py -q`.

#### F24 · La Roadmap tourne sous l'agent `coder`

- **Sévérité** moyenne · **nouveau** · **vérifié** (AST : seul appel de fabrique sans `agent_type`)
- **Corrigé par le lot L1**, avec une correction de la recommandation ci-dessous : les trois prompts
  Roadmap exigent que l'agent **crée** son fichier de sortie (outil Write ou `cat > … << 'EOF'`), et la
  phase vérifie qu'il existe. `roadmap_discovery` et `competitor_analysis` n'avaient ni Write ni Bash :
  les utiliser tels quels aurait cassé la Roadmap. Ils reçoivent désormais `Write` et `Bash` (pas
  `Edit`), et `runners/roadmap/executor.py:PROMPT_AGENT_TYPES` nomme la config de chaque prompt.
- **Preuve** : `runners/roadmap/executor.py:130` appelle `self.create_client(...)` (= `create_agent_client`,
  `runners/roadmap/orchestrator.py:61`) sans `agent_type` ; le défaut `coder` (`core/client.py:721,2179`)
  donne Write, Edit, Bash et le roster Kanban (test-runner). Les configs `roadmap_discovery` et
  `competitor_analysis` (lecture + Web + Context7) n'ont aucun appelant.
- **Étapes** : ajouter un paramètre `agent_type` à l'exécuteur de roadmap, passer `roadmap_discovery`
  pour la découverte et les features, `competitor_analysis` pour l'analyse concurrentielle
  (`runners/roadmap/competitor_analyzer.py`). Ajouter les deux à `PHASE_ALIASES` → `"research"`.
- **À préserver** : la génération de roadmap et ses fichiers de sortie (`.workpilot/roadmap/`).
- **Acceptation** : le test AST de F1 passe ; une génération de roadmap produit les mêmes artefacts.
- **Vérification** : `pytest tests/test_roadmap_validation.py -q` + lancement manuel de la page Roadmap.

### Lot L2 — La phase `architecture-map` produit la carte (P0)

#### F20 · La phase `architecture-map` du build ne produit pas la carte

- **Corrigé par le lot L2.** Le pipeline d'`action_delta` vit dans
  `architecture_visualizer/archify/task_delta.py::run_task_delta` (le runner CLI y délègue) ;
  `archify/phase.py::run_architecture_map_phase` est l'exécuteur de la phase (`CUSTOM_EXECUTORS`),
  qui crée ses sessions d'authoring sous `architecture_visualizer` via `verify.phase.make_agent_runner`.
  `significance.assess` passe en premier : un changement non significatif n'ouvre aucune session.
  `PhaseContext` porte `source_project_dir` (la baseline vit sous le `.workpilot/` du projet principal,
  absent du worktree) et `source_spec_dir` (le record est écrit dans le spec_dir que lit le Kanban, car il
  référence ses artefacts par chemin absolu) ; une synchronisation après la fenêtre post-QA ramène
  `workflow/`, `verify/` et le modèle de tête dans le spec principal. `architecture_visualizer` reçoit le
  roster `solo`. Tests : `tests/test_architecture_map/test_task_delta.py`.

- **Sévérité** haute · **nouveau** · **lu**
- **Preuve** : `architecture-map` n'est ni dans `SKILL_PHASE_AGENTS` (`workflows/runner.py:198-212`) ni
  dans `CUSTOM_EXECUTORS` (`workflows/runner.py:870`). `run_skill_phase` l'exécute donc sous
  `_DEFAULT_AGENT = "analyzer"` (l.213, 757) : `BASE_READ_TOOLS` seulement, pas de `Write`. Le
  `SKILL.md` (`skills/tooling/architecture-map/SKILL.md`) annonce « le pipeline autour de toi exécute
  `validate`, `deliver` et `compare` » ; ce pipeline n'existe que dans
  `runners/architecture_visualizer_runner.py --action delta`, déclenché uniquement par le bouton
  Regenerate (`main/ipc-handlers/architecture-visualizer-handlers.ts:85`). Ni `significance.assess`
  (censé décider à zéro token), ni archify : la réponse texte est écrite dans
  `<spec_dir>/workflow/architecture-map.md` (`_write_output`, l.573) et l'onglet Delta reste vide.
- **Étapes**
  1. Extraire l'orchestration de l'action `delta` de `runners/architecture_visualizer_runner.py` dans
     une fonction de module (ex. `architecture_visualizer/archify/delta.py:run_task_delta(project_dir,
     spec_dir, changed_files, provider, model)`), que le runner CLI appelle désormais.
  2. Ajouter `async def _run_architecture_map(resolved, ctx)` dans `workflows/runner.py` qui appelle
     cette fonction via `asyncio.to_thread` si elle est synchrone ; l'enregistrer dans
     `CUSTOM_EXECUTORS`. `significance.assess` passe en premier et renvoie « not-significant » sans
     session quand rien d'architectural n'a changé.
  3. Ajouter `"architecture-map": "architecture_visualizer"` à `SKILL_PHASE_AGENTS` (filet de sécurité).
  4. Corriger la description de la phase dans `docs/CLAUDE.md` si elle diverge encore.
- **À préserver** : la page Architecture, le bouton Regenerate, `TaskArchitectureDelta` et ses six états.
- **Acceptation** : un build à effort `medium` qui touche un composant écrit `<spec_dir>/architecture/`
  (record de delta) ; un build qui ne touche rien d'architectural n'ouvre **aucune** session.
- **Vérification** : `pytest tests/test_architecture_map tests/test_workflow_runner.py -q` + un test
  nouveau qui monkeypatch le runner et vérifie que `CUSTOM_EXECUTORS["architecture-map"]` est appelé.

### Lot L3 — Features cassées côté frontend (P0)

#### F21 · Context-aware snippets : feature visible, cassée de bout en bout

- **Corrigé par le lot L3 — câblé** (décision du mainteneur : garder la feature). Runner réécrit sur
  `core.oneshot.oneshot_completion` (tous providers), contexte projet réel (`core/project_brief.py`,
  extrait de `prompt_optimizer_runner` qui le ré-exporte), réponse JSON lue par
  `spec.plan_recovery.extract_json_document`. Service et handlers sur le modèle de prompt-optimizer
  (`registerContextAwareSnippetsHandlers`, enregistré dans `ipc-handlers/index.ts`) ; canal
  `configure` (le renderer choisissait l'exécutable Python) supprimé ; le store ne tourne plus à vide sur
  un échec ; badge d'activité dans la barre latérale. Tests : runner, service, store.

- **Sévérité** haute · **nouveau** · **lu**
- **Preuve**
  - La page est dans la barre latérale : `renderer/components/Sidebar.tsx:109,143,208`
    (`ContextAwareSnippetsDialog`, vue `context-aware-snippets`).
  - Le store appelle `globalThis.electronAPI.generateContextAwareSnippet`
    (`renderer/stores/context-aware-snippets-store.ts:157`) → `ipcRenderer.invoke("context-aware-snippets:generate")`
    (`preload/api/modules/context-aware-snippets-api.ts`).
  - `setupContextAwareSnippetsHandlers` (`main/ipc-handlers/context-aware-snippets-handlers.ts:9`)
    **n'est appelé nulle part** : aucun handler n'est enregistré.
  - Le runner `apps/backend/runners/context_aware_snippets_runner.py:20-28` importe
    `core.context_manager`, `services.project_analyzer` et `memory.bmad_memory`, **qui n'existent pas**
    (seul `src/memory/bmad_memory.py` existe, à la racine du dépôt, hors du chemin) : `_AVAILABLE = False`.
- **Décision produit à prendre (à demander au mainteneur si l'agent ne peut pas trancher)**
  - **Câbler** : enregistrer les handlers dans `main/ipc-handlers/index.ts` (comme les autres
    `setup*Handlers`), réécrire les imports du runner vers des modules existants
    (`project.analyzer` / `project/stack_detector.py`, `brain/project_memory.py` via
    `memory.store.get_project_memory`), construire l'agent via `create_agent_client(agent_type=…)`.
  - **Retirer** : supprimer l'entrée Sidebar, `ContextAwareSnippetsDialog`, le store, l'API preload,
    `context-aware-snippets-service.ts`, les handlers, le runner, les clés i18n (FR + EN), l'entrée
    dans `stores/global-listeners.ts`, et `src/memory/bmad_memory.py` s'il n'a plus d'usage.
- **Acceptation** : soit la génération produit un snippet de bout en bout (test manuel + test du runner),
  soit `grep -rn "context-aware-snippets\|ContextAwareSnippet" apps/` ne renvoie plus rien.

#### F22 · Quatre API preload appellent des canaux IPC sans handler

- **Corrigé par le lot L3 — cinq canaux, pas quatre** : `azureDevOps:getProjects`
  (`getAzureDevOpsProjects`) était dans le même cas. Les cinq méthodes, leurs constantes et leurs mocks
  sont supprimés. `ipc-channel-parity.test.ts` exige un handler, dans un fichier réellement importé par
  `main/index.ts`, pour chaque canal invoqué par le preload ; `handler-registration.test.ts` voit
  désormais aussi les `setup*Handler(s)`. `renderer-log-handler.ts` (jamais enregistré) est supprimé
  plutôt qu'enregistré : le logger du renderer ne filtre rien et aurait inondé le journal du main. Reste
  hors de ce test : les appels du renderer par le pont générique (`shell:openPath`, voir F37).

- **Sévérité** moyenne · **nouveau** · **vérifié** (comparaison invoke/handle)
- **Preuve**
  - `scan-ollama-models`, `download-ollama-model` : `preload/api/project-api.ts:545,551` ; aucun
    `ipcMain.handle` (les canaux réels sont `OLLAMA_LIST_MODELS` / `OLLAMA_PULL_MODEL`).
  - `claude:profileInitialize`, `terminal:oauthCodeSubmit` : `preload/api/terminal-api.ts:541,660`,
    constantes `shared/constants/ipc.ts:151,164`, `ipc-namespaces.ts:145` ; handlers retirés
    (`main/ipc-handlers/terminal-handlers.ts:406,439`).
  - Aucun appelant dans le renderer hors `renderer/lib/mocks/*`.
- **Étapes** : supprimer les quatre méthodes preload, leurs types, constantes et mocks. Ajouter un test
  Vitest qui, à partir des sources du preload et du main, vérifie que chaque canal invoqué a un
  `ipcMain.handle`/`on` dans un fichier de handlers effectivement importé.
- **À préserver** : les canaux `OLLAMA_*` réels.
- **Vérification** : `pnpm run typecheck && pnpm test`.

### Lot L4 — Contexte de développement (P1)

#### F23 · `docs/CLAUDE.md` (268 Ko, ~67 k tokens) chargé dans chaque session Claude Code

- **Sévérité** haute · **nouveau** · **vérifié** (`wc -c docs/CLAUDE.md` = 268 082 ; +23 Ko depuis `7057b28`)
- **Preuve** : `CLAUDE.md` importe `@AGENTS.md` (8 Ko) et `@docs/CLAUDE.md` (4 294 lignes). Toute
  session Claude Code sur ce dépôt — y compris un build de WorkPilot par WorkPilot, puisque le SDK
  charge `CLAUDE.md` du projet via `setting_sources` — paie ~69 k tokens avant la première question.
  Le fichier mêle règles normatives (« Critical Rules », une page) et justifications de conception
  (tout le reste : brain, hermes, docintel, rtk, watermarks, uiux, verify, bounty board…).
- **Étapes**
  1. Créer `shared_docs/architecture/` et y déplacer chaque section de justification, **une feature par
     fichier** (`brain.md`, `hermes.md`, `docintel.md`, `rtk.md`, `watermarks.md`, `uiux.md`,
     `verify.md`, `bounty-board.md`, `workflows.md`, `pause-resume.md`, `offline-mode.md`,
     `frontend-task-panel.md`…). Contenu déplacé tel quel (pas de réécriture dans cette PR).
  2. Réduire `docs/CLAUDE.md` à : règles critiques, structure du dépôt, commandes, et **une table**
     « feature → fichier de justification » avec une phrase par feature. Cible < 20 Ko.
  3. Mettre à jour les ancres citées ailleurs (`AGENTS.md`, `README.md`, prompts qui citent des sections).
  4. Ajouter un test (pytest) qui échoue si `docs/CLAUDE.md` dépasse 25 Ko.
- **À préserver** : toutes les règles normatives ; l'accès à chaque justification par lien.
- **Acceptation** : `wc -c docs/CLAUDE.md` < 20 480 ; aucun lien mort (`grep -o "shared_docs/architecture/[a-z-]*\.md"` → fichiers existants).

#### F18 · Dérives de documentation lues par les agents

- **Sévérité** basse · **aggravé** · **lu**
- **À corriger**
  - `apps/backend/AGENTS.md:35-37` : `agents/kanban_subagents.py`, `planner_subagents.py`,
    `qa_subagents.py` n'existent plus → pointer vers `agents/subagents/phases.py`, `pr_review.py`, `mobile.py`.
  - `AGENTS.md` (table « Skills, agents et workflows ») : les miroirs `.claude/skills/`, `.github/skills/`,
    `.cursor/skills/` ne sont pas émis (`capabilities/harnesses.yaml` : seuls `agnostic` et `gemini` ont
    `default: true`) → le dire.
  - `docs/CLAUDE.md` : mistral/deepseek/grok « pilotés par le SDK Claude » (sections Arena et Bounty
    Board) alors que `capabilities/providers.yaml` leur donne `CompatibleProviderAgentClient` ;
    `pty-daemon.ts` présenté comme gestionnaire de PTY (jamais démarré, F28) ; `significance.assess`
    décrit comme décidant dans la phase architecture-map (faux tant que F20 n'est pas corrigé).
  - `learning_loop/pattern_storage.py:4` : documente `.workpilot/learning/patterns.json`, écrit
    `.workpilot/learning_loop/patterns.json` (l.25-26).
  - `hooks/precommit.py:219` : documente `.workpilot/generational-tests/`, le code écrit `generational_tests`.
  - `spec/complexity.py:54` : commentaire sur Graphiti.
- **Garde-fou** : test pytest qui extrait des `AGENTS.md` chaque chemin entre backticks finissant par
  `.py`, `.ts`, `.tsx`, `.md` ou `/` et vérifie qu'il existe.

### Lot L5 — Droits et rosters minimaux (P1)

**Fait.** Chaque prompt du pipeline de spec tourne sous une config qui accorde ce qu'il utilise, le
plafond de roster compte les agents de l'appelant, un roster vide le reste sur un projet mobile, et
le testeur de la QA connaît la pile du projet. Le plus gros roster passe de 9 à 7 entrées (6 pour
l'orchestrateur de PR). Trois prescriptions de ce cahier étaient fausses ; elles sont corrigées
ci-dessous plutôt que suivies.

#### F4 · Toutes les phases LLM du pipeline de spec tournent sous `spec_writer`

- **Corrigé par le lot L5**, avec une correction du cahier.
- **Ce que le cahier prescrivait** : basculer le chercheur et le critique vers `spec_researcher` et
  `spec_critic`, en lecture seule. Les deux phases auraient cassé **sans bruit** : `spec_researcher.md`
  écrit `research.json` par heredoc, `spec_critic.md` réécrit `spec.md` (`sed -i`) et écrit
  `critique_report.json`. Sans fichier, `create_minimal_research` / `create_minimal_critique` le
  remplacent et la phase rendait un succès (F39, corrigé par L15). La mention « réflexion `high` au lieu de `ultrathink` »
  était fausse aussi : dans ce pipeline le budget est calculé une fois et passé explicitement
  (`spec/pipeline/orchestrator.py:176`) ; l'`agent_type` ne le change pas.
- **Le vrai défaut** était l'inverse : les deux prompts appellent `mcp__context7__*` et le web, que
  `spec_writer` n'accorde pas. La recherche « validait » de mémoire.
- **Correction** :
  - `AgentRunner` lit `PROMPT_AGENT_TYPES` (repli `spec_writer`) aux deux appels.
  - `spec_researcher` reçoit les outils d'écriture.
  - Nouveau type `spec_self_critique` (écriture + Context7) pour `spec_critic.md`. `spec_critic` reste
    le relecteur en lecture seule de la phase `brainstorm`.
  - `spec_discovery` et `spec_context`, sans appelant, sont supprimés, y compris du panneau Agent
    Tools.
  - L'ensemble lecture seule devient `core.client.READ_ONLY_AGENT_TYPES`, lu par les tests au lieu
    d'une copie.
- **Garde-fou** : `tests/test_spec_agent_configuration.py` lit chaque prompt depuis son point
  d'appel et vérifie que sa config accorde ce qu'il utilise (shell, `Write`, Context7, web) et
  n'est pas en lecture seule. Le test échoue sur l'ancien mapping comme sur celui du cahier.

#### F5 · Les orchestrateurs de revue PR portent 9 et 7 sous-agents

- **Corrigé par le lot L5**, avec une correction de la preuve.
- **Preuve corrigée** : `_create_sdk_client` (9 entrées) n'est appelé nulle part, c'est du code mort
  (lot L9). Le chemin vivant lance chaque spécialiste comme une session à part sous `pr_reviewer`,
  qui portait le roster `review` en plus des autres spécialistes : un fan-out dans le fan-out. Le
  suivi (`pr_followup_parallel`, 4 + 3 = 7) était vivant.
- **Correction** :
  - `pr_orchestrator_parallel` et `pr_followup_parallel` → `solo`.
  - `_apply_cap` tourne après la fusion des agents de l'appelant, et ne retire jamais une entrée
    qu'il a nommée.
  - Les sessions spécialistes passent `roster="solo"`.
- **Acceptation** : `resolve('pr_orchestrator_parallel', user_agents=6)` → 6 entrées ; le suivi → 4.

#### F9 · Rosters Kanban servis à des agents qui n'en ont pas l'usage

- **Corrigé par le lot L5.** `roadmap_discovery`, `competitor_analysis` et `architecture_visualizer`
  l'étaient déjà (lots L1 et L2).
- **Correction** :
  - `analysis`, `batch_analysis` et `batch_validation` → `research`. C'est de la couverture : ils
    passent par `create_simple_client`, qui ne compose pas de roster.
  - Le défaut vivant était l'ajout des spécialistes mobiles à **tout** roster. Ils ne rejoignent
    désormais qu'une phase qui a un roster : un `commit_message` sur un projet Android reste vide,
    tandis que coder, QA, verifier et `pr_reviewer` (phases mobiles) les gardent.
- **Invariant** : `test_every_agent_config_names_its_roster`. Toute entrée d'`AGENT_CONFIGS` hors
  `coder` nomme son roster ; la liste tenue à la main en avait manqué neuf.

#### F16 · L'overlay langage ne spécialise pas le testeur de la QA ni du verifier

- **Corrigé par le lot L5.** `_TEST_ROLES = ("test-runner", "qa-test-evidence")` : les deux
  reçoivent les commandes de la pile (langage et mobile), et les deux sont protégés du plafond.

### Lot L6 — Pipeline payé = pipeline exécuté (P1)

**Fait.** Le profil affiché est ce qui s'exécute, et chaque phase skill qui tourne est lue par
l'agent suivant. `validate_impls` est vide à tous les efforts (`TestImplementations` dans
`tests/test_workflow_engine.py`) ; le workflow passe de 19 à 15 phases déclarées.

#### F2 · Cinq phases du workflow pointent encore vers des packs vides

- **Corrigé par le lot L6.** Skills natifs sous `skills/tooling/`, sans vendorisation (aucune
  licence amont déclarée) : `coding` → `tooling/tdd-cycle`, `brainstorm` →
  `tooling/brainstorm-approaches` (non interactif), `review` → `tooling/review-lenses`. `observe` →
  `workpilot/observe` (exécuté par `learning_loop/observe.py`) et le pack `task-observer` est retiré
  de `[packs]`. `design-check` garde `impeccable/impeccable` : `validate_impls` reçoit les packs à
  `gate` (`engine.pack_inventory`), et une phase déterministe dont le pack déclare une gate est
  implémentée par elle. `superpowers`, `mattpocock`, `impeccable` et `claude-mem` restent opt-in.

#### F3 · Les phases BMAD ne tournent presque jamais, et « spec » double le pipeline de spec

- **Corrigé par le lot L6.** `spec`, `adversarial-review` et `spec-conformance` sont retirées du
  workflow. Leur intention devient des lentilles de `review-lenses`, choisies par l'effort :
  correction et tests et sécurité à `medium`, conformité aux critères d'acceptation et à
  `traceability.json` à `high`, lecture adversariale à `ultrathink`. La revue tourne avant la QA,
  là où un fixer peut encore agir ; les deux passes retirées tournaient après. C'est l'amorce de F11.
  Les 50 skills BMAD restent dans la palette pour les projets qui ont `_bmad/`.

#### F15 · Effort `none` : planning annoncé élagué, exécuté quand même

- **Corrigé par le lot L6.** `min_effort: low` est retiré de `planning`. Le profil dit désormais
  que `none` et `low` exécutent les mêmes phases, et c'est vrai : ils diffèrent par le budget de
  réflexion. De même `high` et `ultrathink`, qui diffèrent par les lentilles de la revue. Le test
  de l'échelle d'effort épingle ces marches au lieu d'exiger une phase de plus à chaque niveau.

#### F35 · `frontend-design` et `ui-design-system` visent la même chose avant le coding

- **Corrigé par le lot L6.** `frontend-design` est retirée : son skill n'était jamais sur le disque,
  et sa sortie n'aurait été lue par personne. `ui-design-system` (déterministe) fixe la cible avant
  le code, `design-check` (gate impeccable) note le code après. L'ancre `&frontend_surface` est
  désormais définie sur `design-check`.

#### F38 · Les rapports des phases skill ne sont lus par personne

- **Sévérité** haute · **nouveau** (trouvé pendant le lot L6) · **corrigé par le lot L6**
- **Preuve** : `run_skill_phase` écrit `<spec_dir>/workflow/<phase>.md`. Seul `workflow/verify.md`
  était relu (`build_commands._tests_went_green`). Aucun prompt de planner, de coder ou de QA ne
  lisait les rapports de `brainstorm`, `analyze`, `mobile-design` ou `review` : chaque session était
  payée, et sa sortie n'était utilisée par personne.
- **Correction** : `workflows/handoff.py`. La règle découle de l'ordre déclaré, sans table : un
  rapport va au consommateur intégré suivant.
  - `planning` reçoit le rapport en ligne dans le prompt du planner.
  - `coding` reçoit l'en-tête et le chemin dans chaque sous-tâche, pour borner le coût.
  - `qa` reçoit le rapport en ligne dans le prompt du QA reviewer, avec la consigne de vérifier
    chaque constat.
  - Le texte est nettoyé, scanné par `injection_guard` (seul `blocked` retient), borné à 4 000 et
    8 000 caractères, et clôturé comme données.
  - Les phases qui ont déjà leur lecteur (`verify`, `ui-design-system`, `architecture-map`) ne sont
    pas transmises deux fois.
  - Le QA fixer n'est pas consommateur : il travaille sur la décision du reviewer.
- **Reste ouvert** : les phases déclarées après `qa` (`store-readiness`) n'ont pas de consommateur
  dans le build ; leur rapport n'est pas affiché dans l'UI.

### Lot L7 — Une seule mémoire (P2)

#### F6 · ~12,6 k lignes Graphiti / LadybugDB encore câblées, et en hausse

- **Sévérité** haute · **aggravé** (214 références dans 45 fichiers contre 181) · **lu**
- **Inventaire** (voir aussi l'annexe A)

  | Zone | Fichiers |
  |---|---|
  | Backend, paquet | `integrations/graphiti/` (7 593 l.) |
  | Backend, CLI / runners | `query_memory.py` (762), `runners/memory_lifecycle_runner.py` (254), `runners/team_sync_runner.py` (197), `scripts/test_memory_save.py` |
  | Backend, ponts | `graphiti_config.py`, `graphiti_providers.py` (shims), `memory/graphiti_helpers.py`, `context/graphiti_integration.py`, `runners/github/services/deep_context_provider.py:407`, `cli/utils.py` (13 réf.), `core/client.py` (19), `agents/tools_pkg/models.py` (21), `provider_api.py` (9) |
  | Dépendances | `requirements.txt:29-38` : `real_ladybug`, `graphiti-core` (+ `pandas`, `pywin32` pour eux) |
  | Frontend | `main/memory-service.ts` (861), canaux `MEMORY_*` / `GRAPHITI_*` de `main/ipc-handlers/memory-handlers.ts`, `team-sync-handlers.ts` (502), `memory-lifecycle-handlers.ts` (325), `renderer/stores/memory-lifecycle-store.ts` (193), `renderer/components/memory/TeamSyncPanel.tsx` (580, déjà orphelin), `renderer/components/onboarding/MemoryStep.tsx` (64), `preload/api/modules/team-sync-api.ts`, locales `teamSync.json` |
  | Tests | `tests/test_graphiti.py`, `tests/test_graphiti_search.py` |

- **Étapes** (dans cet ordre, un commit chacune)
  1. **Extraire les 11 canaux `OLLAMA_*`** (`OLLAMA_CHECK_STATUS` … `OLLAMA_ACTIVE_PULLS`,
     `memory-handlers.ts:692-1278`) dans un nouveau `main/ipc-handlers/ollama-handlers.ts`, enregistré
     dans `ipc-handlers/index.ts`. Aucun changement de comportement.
  2. Migrer les appelants de `memory.graphiti_helpers.get_graphiti_memory` vers
     `memory.store.get_project_memory` (même API, `ProjectMemory`).
  3. Supprimer Team Sync et Memory lifecycle (runners, handlers, store, pages, preload, i18n) : le
     partage d'équipe est couvert par le distant git du cerveau (`brain/sync.py`).
  4. Supprimer `MemoryStep` de l'assistant d'onboarding.
  5. Supprimer `integrations/graphiti/`, `query_memory.py`, les shims, `memory-service.ts`, les canaux
     `MEMORY_*`/`GRAPHITI_*`, les entrées `graphiti` d'`AGENT_CONFIGS`/`_map_mcp_server_name`, les tests
     Graphiti et les dépendances.
- **À préserver** : la gestion des modèles Ollama, l'onglet Mémoires (`GET /api/brain/memories`),
  `brain/project_memory.py`, l'import des anciens fichiers `<spec_dir>/memory/` (`import-legacy`).
- **Acceptation** : `grep -rn -i "graphiti\|ladybug" apps/ src/ tests/ --include=*.py --include=*.ts --include=*.tsx`
  ne renvoie que des mentions historiques documentées ; `pip install -r apps/backend/requirements.txt`
  n'installe plus `graphiti-core`.
- **Vérification** : `pytest tests/test_brain*.py tests/test_brain_project_memory.py -q` ; `pnpm run typecheck && pnpm test`.

#### F7 · Deux magasins de « patterns » injectés dans le même prompt

- **Sévérité** moyenne · **ouvert** · **lu**
- **Preuve** : `prompts_pkg/prompt_generator.py:506,586`, `qa/reviewer.py:272`, `qa/fixer.py:235`,
  `runners/github/services/pr_review_engine.py:70`, `ideation/generator.py:60` lisent
  `learning_loop.prompt_injection` (`.workpilot/learning_loop/patterns.json`) à côté de
  `get_memory_context` (vault). Le context mesh lit le second magasin.
- **Étapes** : faire écrire `learning_loop/pattern_storage.py` dans le vault
  (`knowledge/projects/<p>/memory/patterns/`, avec preuves en frontmatter) via `brain.project_memory` ;
  un seul injecteur plafonné en tokens ; migrer `patterns.json` au premier lancement ; adapter
  `context_mesh` pour lire le vault.
- **À préserver** : les gates de promotion et le replay A/B du learning loop.

#### F14 · Un merge écrit dans quatre magasins

- **Preuve** : `cli/workspace_commands.py:45` (usage_tracker), `:374-392` (learning_loop),
  `:395-410` (brain + `uiux.knowledge.record_merged_design_system`) ; `scheduling/dashboard_metrics.py:383`
  tient un cinquième compteur.
- **Étape** : un événement `merge` publié une fois (ex. `services/hooks/hook_service.py`), des abonnés
  enregistrés par feature.

#### F34 · ~60 sous-dossiers `.workpilot/` dont des doublons de nommage

- **Doublons** : `learning` (`learning_loop/conventions.py`) / `learning_loop` ; `memory`
  (`memory_lifecycle_runner`) / `memories` (Graphiti) — disparaissent avec F6 ; `quality`
  (`review/quality_integration.py`) / `quality-rules` (`review/quality_custom_rules.py`) ;
  `generational_tests` (écrit) / `generational-tests` (documenté seulement).
- **Étape** : un nom par feature, migration au premier lancement (déplacer, ne pas supprimer).

### Lot L8 — Code mort frontend (P2)

#### F28 · 57 fichiers frontend sans importeur de production (~16,5 k lignes)

- **Sévérité** moyenne · **nouveau** · **vérifié** (recherche stricte des `import`/`import()`/`require`)
- **Liste** : annexe A.1. Points d'attention :
  - **`main/terminal/pty-daemon.ts`** (586 l.) n'est pas une entrée de `apps/frontend/electron.vite.config.ts:65`
    (seul `src/main/index.ts` l'est) alors que `pty-daemon-client.ts:130` lance `pty-daemon.js` ; et
    `ptyDaemonClient` n'est utilisé que pour `shutdown()` (`main/index.ts:1294`). Supprimer daemon +
    client + appel, puis corriger la section Terminal de `docs/CLAUDE.md`.
  - **`shared/types/providers.generated.ts`** est produit par `scripts/generate-provider-types.js` et
    importé par personne : supprimer le script et sa sortie, ou importer le type là où les providers
    sont typés à la main.
  - Six fichiers ne sont importés que par leurs tests (`AccountSettings.tsx`, `ProfileList.tsx`,
    `ProfileBadge.tsx`, `ProjectInitModal.tsx`, `use-profile-swap-notifications.ts`,
    `sdk-session-recovery-coordinator.ts`) : supprimer le test avec le fichier.
  - Les stores devenus orphelins après suppression d'un composant (ex. `auto-refactor-store.ts`) suivent.
- **Étapes** : `npx knip --include files,exports` pour confirmer ; supprimer **par famille** (UsageIndicator*,
  *ProviderSection, multiconnector, dialogs, lib/, main/) ; retirer les clés i18n devenues inutilisées.
- **À préserver** : les variantes montées (`UsageIndicator.tsx`, `CleanProviderSection.tsx`,
  `GitHubCopilotAuthTerminal.tsx`, `task-log-service.ts`).
- **Vérification** : `pnpm run typecheck && pnpm run lint && pnpm test && pnpm run build`.

#### F25 (frontend) · `ResumeWithProviderDropdown.tsx`

- Supprimer `renderer/components/task-detail/ResumeWithProviderDropdown.tsx` (204 l.) : importé par
  personne, remplacé par `TaskPauseControls` (#290).

### Lot L9 — Code mort backend (P2)

#### F29 · Paquets et modules backend sans importeur (~6,7 k lignes)

- **Sévérité** moyenne · **nouveau** · **lu** (aucun `import`, aucun lancement par chemin depuis le
  frontend, les scripts ou la CI)
- **Liste** : annexe A.2. Points d'attention :
  - `core/agent_client/` est un répertoire **sans `__init__.py`** masqué par le module
    `core/agent_client.py` : `optimized_copilot_agent_client.py` est inatteignable par construction.
  - `sandbox/` n'est importé que par ses propres tests (`sandbox/test_*.py`) : supprimer ensemble.
  - `runners/time_travel_runner.py` : le time travel est servi par `replay/api.py` (`get_time_travel_engine`).
  - Trouvés pendant le lot L5 :
    - les configs `spec_gatherer` et `analysis` n'ont aucun appelant, et `spec_gatherer.md` n'est
      chargé par rien (`requirements.json` est construit en Python) ;
    - `ParallelOrchestratorReviewer._create_sdk_client` et `_define_specialist_agents` ne sont
      appelés nulle part.
  - Trouvé pendant le lot L16 : le chemin IA du runner vocal (`_process_with_ai`,
    `_create_ai_client`, `_build_user_prompt`, `_parse_ai_response`) n'est appelé que par ses tests,
    le classement se fait par mots-clés (`_classify_command`).
- **Vérification** : `pytest tests/ -q`, `ruff check apps/backend/`.

#### F30 · 25 shims de compatibilité à la racine du backend

- **Preuve** : `apps/backend/{agent,client,prompts,progress,debug,worktree,workspace,qa_loop,recovery,…}.py`
  réexportent un module rangé ailleurs (`from core.agent import *`…).
- **Étapes**
  1. Supprimer maintenant les 4 sans importeur : `azure_devops_integration.py`, `client.py`,
     `critique.py`, `linear_config.py`.
  2. Pour les autres, codemod d'imports (`from debug import` → `from core.debug import`, etc.), un shim
     par commit, du plus utilisé au moins utilisé : `debug` (58 imports), `progress` (32),
     `graphiti_config` (32, avec F6), `worktree` (15), `graphiti_providers` (15, avec F6),
     `project_analyzer` (13), `prompts` (9), `agent`/`recovery` (8), `linear_updater`/`workspace` (7)…
- **Précaution** : `worktree.py` et `insight_extractor.py` ne sont pas de simples réexports : ils chargent
  leur cible par `importlib` pour **éviter** `core/__init__.py` et `analysis/__init__.py`, qui importent
  des modules lourds. Les migrer seulement après avoir rendu ces `__init__` paresseux (imports différés),
  sinon le temps de démarrage des runners augmente.
- **À préserver** : les points d'entrée lancés par le frontend (`run.py`, `start_backend.py`,
  `provider_api.py`, `websocket_server.py`, `commit_message.py` si lancé par chemin — vérifier avec
  `grep -rn "<nom>.py" apps/frontend/src`).

#### F32 · Deux arbres `src/connectors` et un second registre de providers

- **Preuve** : `src/connectors/llm_*.py` (1 769 l.) découverts dynamiquement par
  `src/connectors/llm_discovery.py` (`cli/main.py:547-555`, `provider_api.py:165-181`) doublent
  `capabilities/providers.yaml` + `models_registry.py` ; `src/connectors/llm_anthropic.py:19` instancie
  `anthropic.Anthropic()` (règle critique). `apps/backend/src/connectors/llm_anthropic_usage.py` ne se
  résout que parce que `start_backend.py:114` ajoute `apps/backend/src` au `sys.path` ; lancé autrement,
  `provider_api.py:1721` tombe dans son `except ImportError`.
- **Étapes** : déplacer `llm_anthropic_usage.py` dans `core/` (import normal) et retirer le hack de
  `sys.path` ; faire lire `--list-providers` et `provider_api` dans `providers.yaml`/`models_registry` ;
  supprimer les `llm_*.py` sans autre lecteur, puis `tests/test_llm_provider.py` /
  `test_llm_providers_concrets.py` s'ils ne couvrent plus que ces fichiers.
- **À préserver** : les connecteurs `jira/`, `azure_devops/`, `postman/`, `notifications/`, `grepai/`,
  `figma_connector.py`, et `src/connectors/llm_config.py:load_provider_config` tant qu'il est lu
  (`core/model_info.py`, `core/agent_client.py:2591`, `core/client.py:2606`).

#### F33 · Fichiers ponctuels et historiques

- `utils/` (29 fichiers, 3 719 l.) : scripts de diagnostic et de correction ponctuelle, référencés nulle
  part mais lintés par `.github/workflows/lint.yml:82` → archiver (branche `archive/utils` ou wiki) puis
  supprimer, et retirer `utils/` de la commande ruff.
- `docs/pr-1575-fixes.md`, `docs/superpowers/plans/`, `docs/superpowers/specs/` : comptes rendus et
  plans datés → archiver.
- `shared_docs/FEATURE_IDEAS.md` (203 Ko) + `FEATURE_IMPROVEMENTS_AND_NEW_IDEAS.md` (208 Ko) : fusionner
  ou convertir en issues, puis supprimer.
- `docs/CHANGELOG.md` (107 Ko) à côté de `CHANGELOG.md` (14 Ko) : un seul changelog
  (vérifier lequel `scripts/bump-version.js` et la release mettent à jour).
- `apps/backend/scripts/test_memory_save.py` (Graphiti, avec F6) ; `.security-reports/` (vide) ;
  `runners/github/test_context_gatherer.py` à la racine du dépôt → `tests/`.

#### F25 (backend) · Le marqueur `RESUME_WITH_PROVIDER` n'a plus d'écrivain

- **Preuve** : depuis #290, `TASK_RESUME_WITH_PROVIDER` écrit le moteur dans `task_metadata.json` et
  **supprime** le marqueur (`main/ipc-handlers/task/execution-handlers.ts:1891`) ; `crud-handlers.ts:828`
  et `execution-handlers.ts:2005` le suppriment aussi ; aucun code ne l'écrit.
- **Étapes** : garder la lecture **une version** (tâches mises en pause avant la mise à jour), puis
  retirer `_consume_resume_with_provider_marker`, `RESUME_WITH_PROVIDER_FILE`, le paramètre `consume`
  de `_get_active_provider` (`core/client.py:1647-1717,1841`) et les commentaires associés
  (`agents/coder.py:1279,1715`, `workflows/api.py:23`, `cli/build_commands.py:169`, `cli/utils.py:171`).
  `peek_active_provider` peut alors devenir un alias, puis disparaître.
- **Vérification** : `pytest tests/test_task_engine_lock.py tests/test_phase_provider_resolution.py apps/backend/core/test_resume_with_provider.py -q`
  (adapter le dernier une fois le marqueur retiré).

### Lot L10 — Tokens à haut effort (P3)

#### F10 · Prompts volumineux et onze prompts orphelins

- **Orphelins** (aucune référence par nom dans le code, le YAML ou le frontend ; annexe A.3) :
  `github/pr_orchestrator.md` (14,6 Ko), `coder_recovery.md` (8,9), `intent_templates.md`,
  `environment_cloner.md`, `performance_profiler.md`, `github/issue_analyzer.md` (cité en commentaire
  seulement), `documentation_agent.md`, `code_migration.md`, `multi_repo_planner.md`,
  `breaking_change_detector.md`, `browser_agent.md` — ~51 Ko. Vérifier les chargements dynamiques
  (`grep -rn "prompts_dir\|load_prompt\|\.md\"" apps/backend`) avant suppression ; mettre à jour la table
  des prompts de `docs/CLAUDE.md`.
- **Gros prompts vivants** : `coder.md` 35 Ko (~8,8 k tokens), `planner.md` 33 Ko,
  `github/pr_parallel_orchestrator.md` 33 Ko, `complexity_assessor.md` 21 Ko.
  - Découper `coder.md` en noyau + modules chargés selon la pile détectée.
  - N'appeler `complexity_assessor` que si `ComplexityAnalyzer` (heuristique, `spec/complexity.py`) a
    une confiance faible.

#### F11 · Jusqu'à sept sessions relisent le même diff

- **Preuve** : `self_review` (par sous-tâche), `review`, `verify` (session `verifier` ≥ medium,
  `verify/loop.py:573-590`), `qa_reviewer` (+ `qa-acceptance-checker`), `adversarial-review`,
  `spec-conformance`, `architecture-map` (F20).
- **Étape** : une phase de revue unique à **lentilles** (qualité, sécurité, adversariale, conformité aux
  critères) dont l'effort choisit le nombre ; `verify` garde son rôle de preuve d'exécution ; la QA
  reste la décision.

#### F17 · Plafond de QA à 50 itérations

- `qa/loop.py:153` (`MAX_QA_ITERATIONS = 50`) : rendre le plafond dépendant de l'effort ou d'un budget
  de coût par tâche ; garder l'escalade humaine sur problème récurrent.

### Lot L11 — Consolidation (P3)

#### F8 · Sous-agents qui répondent à la même question, déclarés à cinq endroits

- Couples : security-auditor / security-reviewer ; code-reviewer / quality-reviewer ; test-runner /
  qa-test-evidence ; evidence-collector / finding-validator (déclaré deux fois :
  `agents/subagents/pr_review.py` et `parallel_followup_reviewer.py:262`) ; spec-explorer /
  codebase-surveyor / architecture-analyst ; store-readiness-auditor / mobile-release-manager ;
  net-architect / bmad-net-architect ; performance-analyst / bmad-performance-analyst.
- Les trois sous-agents du suivi PR sont déclarés en ligne (`parallel_followup_reviewer.py:222-262`).
- **Étape** : ~14 définitions, toutes dans `agents/subagents/` ; rosters par nom ; les agents des packs
  `skills/dotnet/agents/` et `skills/mobile/agents/` dédoublonnés.

#### F26 · Au moins onze détecteurs de pile

- `project/stack_detector.py`, `project/framework_detector.py`, `agents/subagents/__init__.py:48`
  (`detect_languages`), `docintel/api_tests.py:86`, `spec/validation_strategy.py:131`,
  `runners/pipeline_generator_runner.py:59`, `runners/flaky_tests_runner.py:301`,
  `runners/app_emulator_runner.py:23`, `uiux/stack.py:267`, `mobile/stacks.py`, `test_generation/stack_aware.py`.
- **Étape** : une façade `project/stack.py` (langages, frameworks, UI, mobile, API, tests) adossée à
  `StackDetector` + `FrameworkDetector`, avec `mobile.stacks` et `uiux.stack` comme sous-modules ;
  migrer d'abord `detect_languages`, `detect_api_stack`, `validation_strategy`, `pipeline_generator`,
  `flaky_tests`.

#### F27 · Cinq listes de globs « surface »

- `workflows/feature-build/workflow.yaml` : `&ui_surface`, `&frontend_surface`, la liste mobile
  recopiée dans `mobile-design` **et** `store-readiness` (sans ancre), la liste d'`architecture-map` ;
  `uiux/surface.py` duplique `&ui_surface` (gardé égal par `tests/test_uiux.py`).
- **Étape** : ancre `&mobile_surface` ; documenter ou supprimer l'écart ui/frontend ; générer
  `UI_GLOBS` depuis le YAML (ou l'inverse).

#### F31 · Tests dispersés et deux configurations pytest contradictoires

- 125 `test_*.py` dans `apps/backend` hors `tests/` (dont 5 à la racine du backend :
  `test_e2e_provider_switch_resume.py`, `test_model_info_provider.py`, `test_ollama_tool_capability.py`,
  `test_provider_models_catalog_ollama.py`, `test_validated_keys_db.py`).
- `pytest.ini` (racine) collecte `tests`, `apps/backend`, `src` ; `apps/backend/pyproject.toml:4`
  déclare `testpaths = ["tests"]`, dossier inexistant.
- **Étape** : déplacer vers `tests/<paquet>/` (git mv, imports ajustés), une seule configuration.

#### F36 · Fichiers géants

- `core/agent_client.py` (5 532 l. : tous les adaptateurs) → `core/agent_clients/<provider>.py` avec
  réexport depuis `core/agent_client.py` le temps de migrer ;
  `main/ipc-handlers/task/worktree-handlers.ts` (5 665), `main/claude-profile/usage-monitor.ts` (4 609),
  `renderer/components/KanbanBoard.tsx` (4 297, index local `kanban/AGENTS.md`),
  `renderer/components/api-explorer/ApiExplorer.tsx` (3 707), `main/ipc-handlers/github/pr-handlers.ts`
  (3 480), `core/worktree.py` (3 382) → découper par responsabilité, interfaces publiques inchangées.

### Lot L12 — Gouvernance (P3)

#### F12 · `hermes-learned` listé dans `[packs]` contre la règle documentée

- `.workpilot/skills.toml` liste `hermes-learned = "latest"` et `claude-mem = "latest"`. La doc fait de
  l'absence de `hermes-learned` la barrière qui empêche un skill écrit par un agent d'atteindre les
  harness sans relecture.
- **Étape** : retirer les deux lignes ; `python3 scripts/skills_cli.py build` ; ajouter un test qui
  interdit `hermes-learned` dans `[packs]`.

#### F13 · La barre de commandes résout encore son provider avec `_get_active_provider`

- `slash_commands/api.py:417` (exécution) ; la résolution des surcharges l.205 utilise déjà
  `peek_active_provider`. Remplacer ; disparaît de toute façon avec F25.

### Lot L13 — Surface produit (P4)

#### F19 · Surface produit très large

- 78 vues dans la barre latérale (`renderer/components/Sidebar.tsx:176`), 120 stores, 110 modules IPC
  (178 fichiers), 69 runners, 113 paquets backend, ~433 k lignes TS/TSX et ~349 k lignes Python hors tests.
- **Étape** : instrumenter l'usage par vue (le registre `stores/activity-store.ts` existe), décider avec
  le mainteneur des pages à regrouper ou à déplacer derrière un mécanisme de plugins. Aucune
  suppression sans donnée d'usage.

### Lot L14 — Événements et appels IPC perdus en silence (P1)

#### F37 · Six features n'envoient jamais leurs événements de progression au renderer

- **Sévérité** moyenne · **nouveau** (trouvé pendant le lot L3) · **vérifié** (lecture)
- **Preuve**
  - Les relais d'événements de `code-playground`, `performance-profiler`, `code-migration`,
    `auto-refactor`, `architecture-visualizer` et `documentation-agent` lisent `global.mainWindow` /
    `globalThis.mainWindow` (`main/ipc-handlers/*-handlers.ts`) ; `main/index.ts` ne l'affecte qu'à
    `null` (l.558), jamais à la fenêtre : ces relais n'envoient rien.
  - `setupAutoRefactorEventForwarding` (`auto-refactor-handlers.ts:70`) n'est appelé nulle part.
  - `PluginCreatorWizard.tsx:587` invoque `shell:openPath` par le pont générique : aucun handler, et
    aucune API preload n'ouvre un dossier arbitraire (`openExternal` refuse `file:`).
- **Étapes** : faire passer ces relais par `getMainWindow` (le paramètre que reçoivent déjà les
  `register*Handlers`) ou `safeSendToRenderer`, appeler `setupAutoRefactorEventForwarding`, et ajouter
  une API dédiée « ouvrir le dossier » validée côté main (chemin sous le projet) ou retirer le bouton.
  Étendre `ipc-channel-parity.test.ts` aux appels `electronAPI.invoke/send("…")` du renderer.
- **À préserver** : les six pages concernées et le bouton du créateur de plugins.
- **Vérification** : un test par relais (fenêtre factice, événement reçu) ; `pnpm run typecheck && pnpm test`.

### Lot L15 — Droits effectifs et succès silencieux (P1)

**Fait.** Un type d'agent n'a plus que les outils qu'il déclare, sur le SDK Claude comme chez les
fournisseurs hors SDK, et les déclarations disent ce que les prompts utilisent. Une phase de spec
qui n'a rien produit le dit, dans son fichier et dans le journal de la tâche, et la reprise la
rejoue. Les droits construits hors de `create_client` sont le lot L16.

#### F39 · Une phase de spec qui n'a pas écrit son fichier rend un succès

- **Corrigé par le lot L15.**
- **Ce que le cahier ne voyait pas** :
  - le remplaçant était **permanent** : la reprise sautait la recherche dès que `research.json`
    existait ;
  - la critique de remplacement affirmait `no_issues_found: true`, l'indicateur même que lit la
    reprise ;
  - l'orchestrateur jetait les `errors` d'un résultat réussi, pour toutes les phases ;
  - le journal des tâches n'avait aucun type « avertissement ».
- **Correction** :
  - `create_minimal_research` / `create_minimal_critique(placeholder=True)` marquent le fichier
    (`"placeholder": true`, la raison). Un remplaçant de critique ne dit plus `no_issues_found`.
    `validator.is_placeholder` lit la marque ; un fichier illisible compte comme un remplaçant.
  - La recherche et l'autocritique posent la marque sur les deux branches (« l'agent n'a rien
    écrit », « échec après essais »). La reprise rejoue une phase dont le fichier est un
    remplaçant. Le `json.load` de la critique ne fait plus tomber la phase sur un rapport illisible.
  - `PhaseResult.warnings`. `phase_notes` réunit avertissements et erreurs d'une phase réussie,
    `orchestrator._report_phase_warnings` les écrit en `LogEntryType.WARNING` (phase de
    planification) et les imprime. Le `create_minimal_plan` silencieux de la spec rapide aussi.
  - Frontend : `TaskLogEntryType` reçoit `"warning"`, rendu en ligne ambre dans l'onglet Journaux.
- **Écart avec le cahier** : la carte de la tâche n'affiche rien. Le journal suffit pour lire ce
  qu'une phase n'a pas fait ; un badge sur la carte demanderait un champ persisté que rien ne porte
  encore.
- **Garde-fou** : `tests/test_spec_phases.py` (`TestPlaceholdersAreSaid`, `TestPhaseNotes`) et
  `TaskLogs.warning.test.tsx`.

#### F40 · `allowed_tools` n'est pas une barrière pour les types hors lecture seule

- **Corrigé par le lot L15.** Vérifié sur le SDK épinglé (claude-agent-sdk 0.2.163) :
  `allowed_tools` approuve d'avance et ne retire rien, `disallowed_tools` retire l'outil du contexte
  du modèle et l'emporte sur les règles `allow` du fichier de réglages.
- **Ce que le cahier ne voyait pas** :
  - côté hors SDK, `ToolExecutor.execute` exécutait n'importe quel nom envoyé par le modèle, même un
    outil jamais offert ;
  - Codex lançait toujours `--sandbox workspace-write` ;
  - les déclarations étaient fausses **dans l'autre sens** : `ideation` écrit son JSON et explore
    par heredoc avec une config qui ne déclarait que lecture et web, le skill `review-lenses`
    demandait `git diff` à une phase sans shell, et `_REPORTING` demandait à toutes les phases
    skill, en lecture seule, d'« écrire le fichier ». Appliquer les déclarations sans les corriger
    aurait cassé l'idéation en silence.
- **Ce que le cahier prescrivait et qui n'est pas fait** : dériver le fichier de réglages de la
  config du type. Il est partagé par répertoire de projet et réécrit à chaque appel ; un fichier par
  client aurait été un second mécanisme pour la même question. Le refus l'emporte sur lui.
- **Correction** :
  - Déclarations : `ideation` déclare `Write` et `Bash`, pas `Edit`. `review-lenses` lit les
    fichiers listés au lieu de `git diff`. `_REPORTING` dit que la réponse est le rapport.
    `_TOOL_USE_HINT` ne promet plus `write_file` ni `run_command`.
  - `agents/tools_pkg/permissions.py` : `GUARDED_TOOLS`, `declared_tools`,
    `undeclared_builtin_tools`. Un type inconnu reste permissif (le test AST du lot L1 garantit
    qu'aucun n'atteint la production).
  - SDK : `create_client` et `create_simple_client` passent `disallowed_tools`.
    `READ_ONLY_AGENT_TYPES` gardent le mode `plan` en plus.
  - Hors SDK : `get_tool_definitions(agent_type)` n'offre `write_file`, `Write` et
    `create_directory` qu'à un type qui déclare `Write` ou `Edit`, et `run_command` qu'à un type qui
    déclare `Bash`. `ToolExecutor(agent_type=…).execute` refuse les mêmes outils par nom, avec un
    message renvoyé au modèle. Copilot, OpenAI (et ses héritiers), Windsurf et LiteLLM passent leur
    type.
  - Deux outils en lecture seule remplacent la recherche par le shell : `search_files` (regex) et
    `find_files` (glob), offerts à un type qui déclare `Grep` ou `Glob`, confinés au projet, sans
    lien, bornés à 200 résultats et 1 Mo par fichier.
  - Codex : `codex_sandbox_for` donne `read-only` à un type qui ne déclare ni `Write`, ni `Edit`,
    ni `Bash`.
- **Mesuré** : `pr_reviewer` perd `Write`, `Edit`, `MultiEdit`, `NotebookEdit` et `Bash` ; `coder`
  ne perd rien ; `commit_message` perd tout ; `architecture_visualizer` garde `Write`.
- **Garde-fous** :
  - `tests/test_agent_tool_rights.py` : options capturées par type, invariant sur tous les
    `AGENT_CONFIGS`, offre et refus de l'exécuteur, recherche, sandbox Codex.
  - `tests/test_agent_tool_declarations.py` : chaque prompt et chaque `SKILL.md` qu'un type
    charge, tenu à sa déclaration (shell, `Write`, Context7, web).

### Lot L16 — Droits hors de `create_client` (P1)

**Fait.** Un seul endroit construit les options du SDK, et ce que le SDK vérifie (liste autorisée,
garde-fous de l'utilisateur, serveurs MCP par type, sandbox) est vérifié aussi chez les
fournisseurs qui ne passent pas par lui. Deux défauts trouvés en chemin sont corrigés dans le
même lot (F46, F47) ; un troisième, hors du thème, ouvre le lot L17.

#### F41 · Huit constructions de `ClaudeAgentOptions` hors de `create_client`

- **Corrigé par le lot L16.**
- **Ce que le cahier ne voyait pas** :
  - `create_simple_client` n'installe aucun hook, et deux chemins y menaient des types qui
    écrivent ou lancent des commandes : `spec_compaction` déclarait Write, Edit et Bash pour
    résumer un texte en un tour, et le planner de suivi (`agents/planner.py`) passait par
    `create_agent_runtime` → `ClaudeSDKRuntime` → `create_simple_client(agent_type="planner")`
    (F46) ;
  - `agents/tools_pkg/__init__.py:25` est un exemple de docstring, pas un appel ;
  - `src/connectors/llm_claude.py` en construit une neuvième ; elle n'atteint aucune session
    (`ClaudeSDKClient.query_sync` n'existe pas) et part avec F32 (lot L9).
- **Correction** :
  - Chaque site passe par `create_simple_client` avec un type enregistré, sans outil : `insights`
    (déjà utilisé par le chemin hors Claude du même runner), `voice_command`, `git_command`,
    `code_playground`, `linear_updater` (le serveur Linear déclaré), `pr_followup_reviewer`
    (sortie structurée, aucun outil sur un prompt fait de commentaires de PR). Rosters : `solo`.
  - `create_simple_client` refuse un type qui déclare Write, Edit ou Bash (`hooked_grants`) avant
    toute configuration, et n'accepte un serveur MCP que si le type le déclare ; ses outils sont
    alors approuvés. `spec_compaction` ne déclare plus rien.
  - Le runner vocal gardait un client que personne n'utilisait, comme drapeau de disponibilité :
    c'est un booléen, et le client est créé par commande.
- **Garde-fous** : `tests/test_sdk_options_factories.py` — aucun appel à `ClaudeAgentOptions(` ni
  à `ClaudeSDKClient(` hors des deux fabriques (exemption datée pour `llm_claude.py`, qui tombe
  avec le fichier) ; tout type à hooks refusé ; tout `create_simple_client(agent_type=…)` et tout
  `create_agent_runtime(agent_type=…)` littéral sans hooks ; options capturées des sites migrés.

#### F42 · Le pont MCP hors SDK offre tous les serveurs personnalisés à tous les types

- **Corrigé par le lot L16.**
- **Ce que le cahier ne voyait pas** : le pont validait les serveurs avec son propre contrôle,
  qui acceptait n'importe quelle commande (`bash -c …`, un chemin, `python -c`, un champ `env`).
  Le SDK les passe par `_validate_custom_mcp_server` (`id` et `name`, lanceur parmi npx, node,
  python, uv…, aucun drapeau qui évalue du code, aucun champ hors schéma) et refuse de les
  démarrer.
- **Correction** : `core/mcp_tools.load_mcp_server_configs_for(agent_type, …)` applique les deux
  étapes du SDK — le validateur, puis `get_required_mcp_servers` (un serveur rejoint un type que
  le projet lui ajoute, `AGENT_MCP_<type>_ADD`, le réglage par agent du panneau Agent Tools).
  `OpenAIAgentClient` et ses héritiers ne connectent plus que ceux-là.
- **Changement visible** : un serveur personnalisé n'atteint plus un agent hors SDK sans être
  ajouté à cet agent, comme sur Claude.
- **Garde-fou** : `tests/test_non_sdk_rights.py` (`TestTheBridgeOffersWhatTheTypeIsGiven`),
  dont la comparaison directe avec la réponse du SDK pour quatre types.

#### F43 · `run_command` n'a aucun validateur de sécurité hors SDK

- **Corrigé par le lot L16.**
- **Ce que le cahier ne voyait pas** : `create_client` pose deux hooks sur `Bash` — la liste
  autorisée et les garde-fous de l'utilisateur (`.workpilot/guardrails.yaml`) — et le second
  aussi sur chaque outil d'écriture. Hors SDK, ni l'un ni l'autre.
- **Correction** :
  - `security.hooks.command_refusal` : `validate_command_line` sur le profil du projet (repli sur
    les commandes de base, comme le hook), puis `guardrail_refusal("Bash", …)`, qui appelle
    `guardrails_hook` lui-même. `ToolExecutor._run_command` l'interroge avant de lancer quoi que
    ce soit et renvoie le refus au modèle, comme pour un outil non déclaré.
  - La réécriture rtk vient après le verdict, comme sur le SDK où son hook est enregistré
    derrière les deux qui décident ; la liste autorisée voit à travers un préfixe `rtk`.
  - `_write_file` passe par `guardrail_refusal("Write", …)` avant le nettoyage des filigranes,
    l'ordre du SDK.
- **Effet de bord** : `tests/test_local_command_execution.py` lançait `python -c` dans un
  répertoire vide, ce que la liste autorisée refuse ; ses tests de processus tournent désormais
  dans un projet Python.
- **Garde-fou** : `tests/test_non_sdk_rights.py` (`TestACommandPassesTheChecksTheSdkApplies`,
  `TestAWritePassesTheGuardrailsTheSdkApplies`) — même raison que `bash_security_hook`, commande
  refusée jamais lancée, préfixe `rtk` sans effet, garde-fou de commande, de chemin et de contenu,
  réécriture seulement après le verdict.

#### F44 · La reprise Codex n'a pas de sandbox

- **Corrigé par le lot L16.** Vérifié sur codex-cli 0.162.1 : `codex exec resume --sandbox …`
  échoue (« unexpected argument »), `-c sandbox_mode="…"` est lu et validé (une valeur inconnue
  est rejetée).
- **Correction** : `build_codex_exec_args` passe `-c sandbox_mode="<mode>"` à la reprise, avec le
  mode de `codex_sandbox_for` ; une nouvelle session garde `--sandbox`.
- **Garde-fou** : `tests/test_codex_cli_client.py` (la reprise porte le mode du type, jamais un
  mode inconnu).

#### F45 · Copilot demande `implementation_plan.json` à toute session qui peut écrire

- **Corrigé par le lot L16.**
- **Ce que le cahier ne voyait pas** : la relance n'était pas seulement inutile, elle était
  dangereuse — un `coder` ou un `qa_fixer` à court de tours recevait l'ordre d'écrire
  `implementation_plan.json` « avec le contenu JSON COMPLET », soit le plan qu'il exécutait. Et
  `spec_writer` n'a pas un fichier de sortie : `spec_writer.md` finit par `spec.md`, `planner.md`
  et `spec_quick.md` par le plan, `complexity_assessor.md` par son évaluation.
- **Correction** : `_REQUIRED_OUTPUT_FILE` — les relances visent `planner` (qui reçoit le nom
  du plan) et `spec_writer` (renvoyé au fichier que ses instructions exigent), rien d'autre.
- **Garde-fou** : `tests/test_copilot_integration.py` (`TestCopilotWriteNowNudge`) — ni
  `coder`, ni `qa_fixer`, ni `ideation` relancés ; le planner nommé ; `spec_writer` sans nom.

#### F46 · Le planner de suivi n'a jamais tourné

- **Sévérité** haute · **nouveau** (trouvé pendant L16) · **corrigé par le lot L16**
- **Preuve** : `run_followup_planner` (`agents/planner.py`, `--followup` du CLI) passait le
  résultat de `create_agent_runtime` à `run_agent_session`. Aucun `AgentRuntime`
  (`ClaudeSDKRuntime`, `LiteLLMRuntime`, `CopilotRuntime`) n'a `query` ni `receive_response` :
  la session échouait au premier appel, sur tous les fournisseurs. Sur Claude, le runtime
  construisait en outre un `create_simple_client(agent_type="planner")` — Write, Edit et Bash
  sans aucun hook — limité à dix tours.
- **Correction** : `_create_planning_client` — `create_agent_client(agent_type="planner")`, la
  fabrique de la première planification (`agents/coder.py`), avec la même résolution du
  fournisseur ; un client par tentative, si bien qu'une reprise après limite de débit ou un
  changement de moteur à chaud ouvre sa propre session.
- **Reste** : `create_agent_runtime` ne sert plus qu'à l'extracteur d'insights, qui appelle
  `run_session` ; candidat à la consolidation (L11).

#### F47 · Aucun outil Linear n'était approuvé

- **Sévérité** moyenne · **nouveau** (trouvé pendant L16) · **corrigé par le lot L16**
- **Preuve** : `LINEAR_TOOLS` nommait `mcp__linear-server__…` (le nom du guide de Linear) alors
  que `create_client` et la mise à jour Linear enregistrent le serveur sous `linear` : aucune des
  seize approbations ne désignait un outil existant, et dans une session sans personne à qui
  demander, chaque appel Linear était refusé. Les prompts citaient les mêmes noms.
- **Correction** : préfixe `mcp__linear__` dans la liste et dans les prompts
  (`integrations/linear/`).
- **Garde-fou** : `TestEveryApprovedMcpToolNamesAServerTheSessionHas` — sur `create_client`, tout
  outil MCP approuvé nomme un serveur de la session.

### Lot L17 — Self-healing : un correctif annoncé sans avoir été fait (P0)

#### F48 · Le pipeline de self-healing rapporte un correctif, une QA et une PR qu'il n'a pas faits

- **Sévérité** haute · **nouveau** (trouvé pendant L16) · **lu**
- **Preuve** : `self_healing/incident_responder/orchestrator.py` — l'étape « Generating fix in
  isolated worktree » se termine `completed` sans lancer d'agent (« This is a placeholder for the
  pipeline integration point »), « Running QA validation » se termine « QA validation passed »
  sans rien valider, « Creating pull request » se termine « PR created » sans en créer, puis
  l'incident reçoit `resolved_at` et `finalize(success=True)`. Seule la vérification d'exécution
  (`_verify_runtime`) est réelle.
- **Étapes** : câbler l'étape de correctif (session `create_agent_client` dans un worktree, puis
  la boucle QA existante et la création de PR du runner GitHub) **ou** marquer ces étapes
  `skipped` et l'incident non résolu tant qu'elles ne sont pas câblées. Une étape qui n'a rien
  fait ne s'affiche jamais `completed`.
- **À préserver** : la détection d'incidents, la vérification d'exécution et le cycle hermes.

### Lot L17 — Le self-healing ne revendique que ce qu'il fait (P1)

**Fait.** Le pipeline de réparation d'incident ne dit plus avoir généré un fix, validé une QA ni
ouvert une PR : ces étapes sont `skipped` avec leur raison, l'incident finit `escalated` et
l'opération n'est pas un succès. Choix du mainteneur : arrêter de revendiquer plutôt que câbler,
le câblage étant un chantier à part (décrit ci-dessous).

#### F48 · Le pipeline de self-healing marque « réparé » un incident auquel rien n'a été fait

- **Sévérité** haute · **nouveau** · **corrigé par le lot L17**
- **Preuve** (avant correction) : `self_healing/incident_responder/orchestrator.py`,
  `_run_healing_pipeline`. « Generating fix in isolated worktree » passait `completed` sans lancer
  d'agent (« This is a placeholder for the pipeline integration point ») et posait seulement
  `incident.fix_branch = "self-healing/<id>"`, une branche qu'aucune commande git ne créait.
  « Running QA validation » passait `completed` avec « QA validation passed » sans rien valider,
  « Creating pull request » `completed` avec « PR created » sans PR. Puis `resolved_at` et
  `finalize(success=True)`. Seule `_verify_runtime` travaillait. Le tableau de bord comptait
  l'incident résolu et l'opération comme un fix automatique (`auto_fix_rate`).
- **Ce que le cahier ne voyait pas** :
  - aucun chemin n'a jamais écrit `fix_pr_url` : tout incident `pr_created` déjà sur disque vient
    du remplaçant, et le restait après la correction si rien ne le rouvrait ;
  - « Auto-create PRs » désactivé, l'incident restait `qa_running` avec un `resolved_at` ;
  - la description de l'onglet CI/CD promettait « génère un fix automatiquement » ;
  - `HealingStep.status` côté frontend ignorait `skipped`, que `_verify_runtime` écrivait déjà.
- **Correction** :
  - `_skip_step` : fix, QA et PR sont `skipped` avec leur raison (`FIX_NOT_RUN`, `QA_NOT_RUN`,
    `PR_NOT_RUN`), sans `fix_branch` inventée. L'incident finit `escalated` (le statut « une
    personne doit reprendre » qui existait déjà), `error_message = NEEDS_A_PERSON`, sans
    `resolved_at`, et `finalize(success=False)`.
  - `_reopen_claimed_heal`, au chargement : un incident qui porte `self-healing/<id>` sans
    `fix_pr_url` perd cette branche ; s'il était `pr_created` ou `qa_running`, il redevient
    `escalated`. Un incident écarté par une personne reste résolu, un échec reste un échec.
  - Runner : « No fix applied » suivi de la raison de l'incident, au lieu de « Healing failed ».
  - Frontend : `HealingStep.status` reçoit `skipped` (pastille et libellé ambre
    `selfHealing:stepSkipped`) ; une opération escaladée affiche `selfHealing:needsReview` au lieu
    de « Échoué » ; la carte d'un incident escaladé dit pourquoi ; `cicdDescription` dit ce qui
    tourne. Clés en `en` et `fr`.
- **Préservé** : la détection des trois modes et leurs `build_agent_prompt`, la vérification à
  l'exécution (un échec rend toujours l'incident `failed`), le cycle hermes dans le `finally`.
- **Pour câbler plus tard** : une session de correction par `core.client.create_agent_client`
  (`agent_type` enregistré, `coder` ou `qa_fixer`) dans un worktree ; la boucle QA
  (`qa/loop.py`) exige un `spec_dir` dont le plan a toutes ses sous-tâches terminées, donc une spec
  par incident ; la PR par `WorktreeManager.push_branch` puis `create_pull_request`. Chaque étape
  câblée remplace son `_skip_step` et n'écrit `completed` que sur un résultat obtenu.
- **Garde-fous** : `tests/test_self_healing_pipeline.py` (aucune étape `completed` hors analyse,
  vérification et hermes, dans les trois modes ; incident escaladé, aucun fix compté ; incidents
  stockés avant la correction rouverts ; hermes toujours observé) et
  `renderer/components/self-healing/HealingTimeline.test.tsx`.

---

## Annexe A — Inventaire des fichiers candidats

### A.1 Frontend (F28 ; F25 ; F21) — à confirmer par `knip` avant suppression

| Fichier (`apps/frontend/src/…`) | Lignes | Preuve | Action |
|---|---:|---|---|
| `renderer/components/UsageIndicatorAgnostic.tsx` | 558 | aucun importeur | supprimer |
| `renderer/components/UsageIndicatorDumb.tsx` | 550 | aucun importeur | supprimer |
| `renderer/components/UsageIndicatorSimple.tsx` | 482 | aucun importeur | supprimer |
| `renderer/components/settings/ImprovedProviderSection.tsx` | 261 | aucun importeur | supprimer |
| `renderer/components/settings/SophisticatedProviderSection.tsx` | 326 | aucun importeur | supprimer |
| `renderer/components/settings/ThemedProviderSection.tsx` | 401 | aucun importeur | supprimer |
| `renderer/components/settings/multiconnector/*` (5 fichiers) | 759 | aucun importeur | supprimer |
| `renderer/components/settings/AccountSettings.tsx` | 2 227 | test seul | supprimer + test |
| `renderer/components/settings/ProfileList.tsx` | 349 | test seul | supprimer + test |
| `renderer/components/settings/LlmRouterSettings.tsx` | 380 | aucun importeur | confirmer, supprimer |
| `renderer/components/settings/CopilotAuthTerminal.tsx` | 358 | aucun importeur | supprimer |
| `renderer/components/hooks/HooksDialog.tsx` | 1 189 | aucun importeur | confirmer, supprimer |
| `renderer/components/SDKRateLimitModal.tsx` | 596 | commentaire seul | confirmer, supprimer |
| `renderer/components/RateLimitModal.tsx` | 474 | commentaire seul | confirmer, supprimer |
| `renderer/components/AppUpdateNotification.tsx` | 365 | aucun importeur | confirmer, supprimer |
| `renderer/components/StreamingTest.tsx` | 256 | test manuel | supprimer |
| `renderer/components/ReferencedFilesSection.tsx` | 190 | aucun importeur | supprimer |
| `renderer/components/AgentProfiles.tsx` | 149 | aucun importeur | supprimer |
| `renderer/components/AuthFailureModal.tsx` | 136 | commentaire seul | confirmer, supprimer |
| `renderer/components/ProfileBadge.tsx` | 150 | test seul | supprimer + test |
| `renderer/components/ProjectInitModal.tsx` | 117 | test seul | supprimer + test |
| `renderer/components/ProactiveSwapListener.tsx` | 96 | aucun importeur | supprimer |
| `renderer/components/FolderExplorer.tsx` | 56 | aucun importeur | supprimer |
| `renderer/components/auth/Can.tsx` | 30 | aucun importeur | supprimer |
| `renderer/components/auto-refactor/AutoRefactorDialog.tsx` | 523 | commentaire du store seul | confirmer, supprimer (+ store) |
| `renderer/components/azure-devops-import/AzureDevOpsDragProvider.tsx`, `AzureDevOpsDropZone.tsx` | 216 | aucun importeur | supprimer |
| `renderer/components/cost-predictor/CostPredictorDialog.tsx` | 233 | aucun importeur | confirmer, supprimer |
| `renderer/components/decision-logger/DecisionTimeline.tsx` | 323 | aucun importeur | confirmer, supprimer |
| `renderer/components/documentation-agent/DocumentationAgentDashboard.tsx` | 312 | aucun importeur | confirmer, supprimer |
| `renderer/components/memory/TeamSyncPanel.tsx` | 580 | aucun importeur, Graphiti | supprimer (lot L7) |
| `renderer/components/task-detail/ResumeWithProviderDropdown.tsx` | 204 | aucun importeur | supprimer (F25) |
| `renderer/components/task-detail/TaskDetailModalHandlers.tsx` | 212 | aucun importeur | supprimer |
| `renderer/components/task-detail/task-review/TerminalDropdown.tsx` | 55 | aucun importeur | supprimer |
| `renderer/components/ui/sheet.tsx` | 130 | aucun importeur | supprimer |
| `renderer/components/workspace/AddWorkspaceModal.tsx` | 320 | aucun importeur | confirmer, supprimer |
| `renderer/hooks/use-profile-swap-notifications.ts` | 195 | test seul | supprimer + test |
| `renderer/lib/flow-controller.ts`, `scroll-controller.ts` | 287 | aucun importeur | supprimer |
| `renderer/lib/webgl-context-manager.ts` | 205 | aucun importeur | supprimer |
| `renderer/lib/terminal-font-settings-verification.ts` | 92 | aucun importeur | supprimer |
| `renderer/lib/compose-refs-fix.ts` | 85 | aucun importeur | supprimer |
| `renderer/test-logger.ts` | 16 | aucun importeur | supprimer |
| `shared/types/providers.generated.ts` | 55 | généré, jamais importé | supprimer (+ `scripts/generate-provider-types.js`) ou utiliser |
| `shared/utils/powershell-color-support.ts` | 102 | aucun importeur | supprimer |
| `examples/colored-logs-example.ts` | 57 | exemple | supprimer |
| `main/terminal/pty-daemon.ts` (+ `pty-daemon-client.ts`) | 586 | pas une entrée de build ; client jamais connecté | supprimer + appel `shutdown()` |
| `main/services/sdk-session-recovery-coordinator.ts` | 568 | test seul | confirmer, supprimer + test |
| `main/log-service.ts` | 364 | aucun importeur | supprimer |
| `main/fs-utils.ts` | 155 | aucun importeur | supprimer |
| `main/copilot-cli-utils.ts` | 86 | aucun importeur | supprimer |
| ~~`main/ipc-handlers/renderer-log-handler.ts`~~ | 60 | jamais enregistré | **supprimé (L3)** |
| `main/ipc-handlers/context-aware-snippets-handlers.ts` | 77 | jamais enregistré | **câblé (L3), conservé** |
| ~~preload : `scanOllamaModels`, `downloadOllamaModel`, `initializeClaudeProfile`, `submitOAuthCode`, `getAzureDevOpsProjects`~~ | — | canaux sans handler | **supprimés (L3)** |

### A.2 Backend (F29 ; F21 ; F32)

| Fichier (`apps/backend/…` sauf mention) | Lignes | Preuve | Action |
|---|---:|---|---|
| `planner_lib/` | 939 | aucun import | supprimer |
| `prediction/` | 1 055 | aucun import | supprimer |
| `sandbox/` | 1 102 | importé par ses tests seulement | supprimer + tests |
| `core/agent_client/optimized_copilot_agent_client.py` | 481 | répertoire masqué par `core/agent_client.py` | supprimer |
| `core/runtimes/optimized_copilot_runtime.py` | 381 | aucun import | supprimer |
| `migration/models_fixed.py` | 326 | aucun import | supprimer |
| `runners/github/services/review_tools.py` | 619 | aucun import | supprimer |
| `runners/github/multi_repo.py` | 512 | aucun import (`multi_repo_runner` est autre chose) | supprimer |
| `streaming/integration_example.py` | 255 | exemple | supprimer |
| `runners/github/validator_example.py` | 221 | exemple | supprimer |
| `runners/github/bot_detection_example.py` | 154 | exemple | supprimer |
| `runners/jira/jira_work_items_example.py` | 140 | exemple | supprimer |
| `runners/time_travel_runner.py` | 227 | jamais lancé ; `replay/api.py` sert le time travel | supprimer |
| `core/output_schemas.py` | 162 | aucun import | supprimer |
| `cli/quality_commands.py` | 146 | aucun import | supprimer |
| `runners/context_aware_snippets_runner.py` | — | importait 3 modules inexistants | **réécrit (L3), conservé** |
| `src/connectors/llm_*.py` (racine du dépôt, 13 fichiers) | 1 769 | second registre ; `anthropic.Anthropic()` | migrer puis supprimer (F32) |

### A.3 Prompts orphelins (F10)

| Fichier (`apps/backend/prompts/…`) | Octets |
|---|---:|
| `github/pr_orchestrator.md` | 14 649 |
| `coder_recovery.md` | 8 858 |
| `intent_templates.md` | 4 391 |
| `environment_cloner.md` | 3 971 |
| `performance_profiler.md` | 3 070 |
| `github/issue_analyzer.md` | 3 020 |
| `documentation_agent.md` | 2 877 |
| `code_migration.md` | 2 871 |
| `multi_repo_planner.md` | 2 733 |
| `breaking_change_detector.md` | 2 308 |
| `browser_agent.md` | 2 251 |

### A.4 Shims racine `apps/backend/*.py` (F30)

| Shim | Importeurs | Cible |
|---|---:|---|
| `azure_devops_integration.py`, `client.py`, `critique.py`, `linear_config.py` | 0 | supprimer |
| `debug.py` | 58 | `core.debug` |
| `progress.py` | 32 | `core.progress` |
| `graphiti_config.py`, `graphiti_providers.py` | 32, 15 | lot L7 |
| `worktree.py` | 15 | `core.worktree` (chargé par importlib, voir F30) |
| `project_analyzer.py` | 13 | `project` |
| `prompts.py` | 9 | `prompts_pkg.prompts` |
| `agent.py`, `recovery.py` | 8, 8 | `core.agent`, `services.recovery` |
| `linear_updater.py`, `workspace.py` | 7, 7 | `integrations.linear.updater`, `core.workspace` |
| `auto_claude_tools.py` | 6 | `agents.tools_pkg` |
| `qa_loop.py`, `phase_event.py` | 4, 4 | `qa`, `core.phase_event` |
| `prompt_generator.py`, `risk_classifier.py` | 3, 3 | `prompts_pkg.prompt_generator`, `analysis.risk_classifier` |
| `ci_discovery.py`, `scan_secrets.py`, `analyzer.py` | 2 chacun | `analysis.ci_discovery`, `security.scan_secrets`, `analysis.analyzer` |
| `insight_extractor.py`, `linear_integration.py`, `security_scanner.py` | 1 chacun | `analysis.insight_extractor` (chargé par importlib, voir F30), `integrations.linear.integration`, `analysis.security_scanner` |

### A.5 Documentation et scripts (F33)

| Chemin | Taille | Action |
|---|---:|---|
| `utils/` (29 fichiers) | 3 719 lignes | archiver puis supprimer ; retirer de `lint.yml:82` |
| `shared_docs/FEATURE_IDEAS.md` | 203 Ko | fusionner / convertir en issues |
| `shared_docs/FEATURE_IMPROVEMENTS_AND_NEW_IDEAS.md` | 208 Ko | idem |
| `docs/CHANGELOG.md` | 107 Ko | fusionner avec `CHANGELOG.md` |
| `docs/pr-1575-fixes.md` | 9 Ko | archiver |
| `docs/superpowers/plans/`, `docs/superpowers/specs/` | 112 Ko | archiver |
| `apps/backend/scripts/test_memory_save.py` | — | supprimer (lot L7) |
| `.security-reports/` | vide | supprimer |
| `runners/github/test_context_gatherer.py` (racine) | — | déplacer dans `tests/` |

---

## Annexe B — Ce qui a changé depuis l'audit précédent (`7057b28` → `b46a031`)

| PR | Changement | Effet sur les constats |
|---|---|---|
| #288, #289 | Installation / mise à jour de Codex CLI par le bon gestionnaire de paquets | aucun |
| #290 | Chaque tâche possède son moteur (provider × LLM × effort, par phase) | F4 inchangé (provider oui, agent_type non) ; F13 partiel ; **F25** nouveau (marqueur sans écrivain) |
| #291 | ui-ux-pro-max sur les tâches UI uniquement | F14 aggravé (4e écriture) ; **F27**, **F35** nouveaux ; `narrow_to_forecast` réduit les phases conditionnelles sur les tâches backend (gain) |
| #292 | Boucle `/verify` pour tous les providers | F2 partiellement corrigé ; F11 aggravé ; F16 étendu ; F23 aggravé (+370 lignes de doc) |

Statut des constats de l'audit précédent : F1, F3, F4, F5, F7, F8, F9, F10, F12, F16, F17, F19 **ouverts** ;
F2, F13 **partiels** ; F6, F11, F14, F18 **aggravés** ; F15 **atténué**. Nouveaux : F20 à F36.
Depuis : F1 et F24 corrigés (L1), F20 (L2), F21 et F22 (L3), F2, F3, F15, F35 et F38 (L6), F4, F5, F9 et F16 (L5), F39 et F40 (L15), F41 à F47 (L16) ; F37 trouvé pendant L3, F38 pendant L6, F39 et F40 pendant L5, F41 à F45 pendant L15, F46 à F48 pendant L16.

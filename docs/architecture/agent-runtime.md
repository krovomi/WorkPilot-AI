# Le moteur d'agents comme port (`agent_runtime`)

> Plan du 29 octobre, A1, deuxième étape · constat [F131](../audit/findings/F131.md), suite de F101.
> Règle : [`rules/backend.md`](../rules/backend.md#clients-llm--une-seule-fabrique).

## Le problème

`core` construit tous les clients LLM (`create_client`, `create_agent_client`,
`create_simple_client`) et `agents.session` les fait tourner. Une unité qui voulait lancer une
seule session utilitaire importait l'un ou l'autre, donc entrait dans le cycle d'imports des
agents : `core` et `agents` importent la moitié du backend, et la moitié du backend les importait
en retour. Le résolveur de conflits de `merge`, le client Linear d'`integrations`, l'extracteur
d'insights d'`analysis` et le relecteur d'`architecture` n'y étaient que pour cela.

Un import paresseux ne change rien : `tests/test_import_contracts.py` compte chaque `import`, y
compris dans une fonction, parce qu'il reste une dépendance qui casse à l'exécution au lieu de
l'import.

## La forme

```
agent_runtime/            le port : un Protocol, install(), current() ; n'importe rien du backend
core/agent_runtime.py     l'implémentation, installée quand core est importé (core/__init__.py)
merge, integrations,      demandent agent_runtime.current() au lieu d'importer core ou agents
analysis, architecture,
test_generation
```

- **Le port n'ajoute aucun client.** Chaque méthode appelle la fabrique de `core` qu'elle
  nomme (`core.auth`, `core.simple_client`, `core.client`, `core.runtimes`,
  `agents.session`), avec les mêmes hooks, les mêmes droits d'outils et la même
  authentification. La règle « un seul chemin vers un LLM » reste tenue : le port inverse
  l'import, pas le chemin.
- **L'implémentation importe à l'appel.** Importer `core` reste léger, et un test qui remplace
  `core.auth.get_auth_token` ou `core.simple_client.create_simple_client` atteint aussi les
  unités qui passent par le port.
- **`current()` vaut `None` tant que `core` n'est pas importé.** Tout processus qui lance un
  agent importe `core` avant d'atteindre ces unités. Une unité qui reçoit `None` prend le
  chemin qu'elle avait déjà pour « pas de SDK, pas de jeton » : le résolveur de merge sans IA,
  l'extraction d'insights désactivée, la revue d'architecture sans violation ajoutée, le client
  Linear refusé par `ImportError` (que son appelant traitait déjà), le générateur de tests en
  `DetailedError` que le runner transmet à l'UI.
- **Le prompt du relecteur d'architecture** est construit dans `architecture/ai_reviewer.py`
  (`architecture_reviewer_prompt`), plus dans `prompts_pkg`, que la boucle de QA importe : il
  n'avait pas d'autre lecteur.
- **`extract_json_document`**, le lecteur tolérant du JSON d'un modèle, passe de
  `spec.plan_recovery` à `foundation.json_document` : `analysis`, `docintel` et les runners ne
  dépendent plus de `spec` pour lire un objet JSON.

- **Le générateur de tests** (`test_generation/generator.py`, ex-`agents/test_generator.py`)
  appelle `oneshot_completion` par le port : le provider choisi par l'utilisateur, comme avant.
  Avec lui, `test_generation` sort du cycle ; `core.error_details`, que lisent le générateur et
  les runners, devient `foundation.error_details`.
- **Le registre des sous-agents** (`apps/backend/subagents/`, ex-`agents/subagents/`) n'importait
  rien d'`agents` : il devient une unité à lui, et `skills_registry` sort du cycle avec lui. Les
  sorties générées (`.agents/agents/`) nomment leur nouvelle source.
- **La prévision du plan** (`foundation/plan_forecast.py`, ex-`workflows/forecast.py`), lue par
  le moteur de workflows, le coder et `uiux`, n'importe que la bibliothèque standard.

## Ce qui le garde

- `tests/test_import_contracts.py` : `agent_runtime` n'importe rien ; `merge`,
  `integrations`, `analysis`, `architecture`, `subagents` et `test_generation` ont chacun leur
  liste fermée, sans `core` ni `agents`, comme `architecture_visualizer`, `docintel`, `brain`,
  `learning_loop`, `hermes`, `memory` et `uiux` ; `MAX_CYCLE = 10`.
- `tests/test_agent_runtime_port.py` : `core` installe le runtime, le runtime atteint les
  fabriques de `core` au moment de l'appel, et chaque unité sans runtime ou sans jeton prend son
  chemin de repli.

## Où en est le cycle

Le cycle compte 10 unités, l'objectif du plan : le moteur (`core`, `agents`, `harness`,
`context_mgmt`, `qa`, `spec`, `services`, `workflows`, `verify`, `prompts_pkg`). Les unités qui
en lisaient un morceau sans lancer d'agent en sont sorties par `foundation` (parseurs de CI,
traçabilité des exigences, pagination) ou en rendant sa phase au moteur de workflows (archify).
La boucle d'apprentissage n'avait pas besoin du port : son appel au modèle importait un module
qui n'a jamais existé et n'a jamais tourné ([F131](../audit/findings/F131.md)).

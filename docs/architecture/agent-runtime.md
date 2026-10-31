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
analysis, architecture
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
  Linear refusé par `ImportError` (que son appelant traitait déjà).
- **Le prompt du relecteur d'architecture** est construit dans `architecture/ai_reviewer.py`
  (`architecture_reviewer_prompt`), plus dans `prompts_pkg`, que la boucle de QA importe : il
  n'avait pas d'autre lecteur.
- **`extract_json_document`**, le lecteur tolérant du JSON d'un modèle, passe de
  `spec.plan_recovery` à `foundation.json_document` : `analysis`, `docintel` et les runners ne
  dépendent plus de `spec` pour lire un objet JSON.

## Ce qui le garde

- `tests/test_import_contracts.py` : `agent_runtime` n'importe rien ; `merge`,
  `integrations`, `analysis` et `architecture` ont chacun leur liste fermée, sans `core` ni
  `agents` ; `MAX_CYCLE = 20`.
- `tests/test_agent_runtime_port.py` : `core` installe le runtime, le runtime atteint les
  fabriques de `core` au moment de l'appel, et chaque unité sans runtime ou sans jeton prend son
  chemin de repli.

## La suite

Le cycle compte 20 unités : le moteur (`core`, `agents`, `harness`, `context_mgmt`, `qa`,
`spec`, `services`, `workflows`, `verify`, `prompts_pkg`) et des unités qui ne lancent pas
d'agent mais en lisent un morceau (`brain`, `memory`, `learning_loop`, `hermes`,
`skills_registry`, `docintel`, `self_healing`, `uiux`, `test_generation`,
`architecture_visualizer`). L'objectif du plan reste `MAX_CYCLE` ≤ 10.

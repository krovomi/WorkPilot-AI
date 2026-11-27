---
feature: Mode code
summary: >-
  `run_script` pour les fournisseurs de la boucle WorkPilot : un script JavaScript lancé par Node
  (permissions, contexte sans `process`, `require`, `fetch` ni `eval`) dont chaque appel repasse par
  `ToolExecutor.execute` ; arrêté par défaut, choisi par tâche ou phase, compté par la surveillance
  des anomalies, mesuré par le banc ; spike S2 du code mode natif.
---

# Mode code

> Code : `apps/backend/code_mode/`, `core/runtimes/tool_executor.py` (`_run_script`),
> `agents/safety_watch.py`, `bench/lifecycle.py` ; Electron : `main/agent/code-mode-env.ts`,
> `renderer/components/settings/CodeModeSettings.tsx`, `shared/utils/bench-code-mode.ts`.
> Règles : [`rules/security.md`](../rules/security.md) S3 et S4. Plan d'ensemble : lot B1 du plan
> « Claude Ship, Code Mode et Docker Sandboxes » (27/11/2026).

## Le problème

Dans la boucle WorkPilot (`harness/application/loop.py`), chaque appel d'outil coûte un tour de
modèle : le modèle demande, l'exécuteur répond, le résultat entre en entier dans le contexte, le
modèle relit tout pour demander l'appel suivant. Une montée de version qui change la même ligne
dans trente fichiers, une recherche dont on ne lit que trois résultats, lint puis type check puis
tests : autant de tours, et de tokens, pour des appels que le modèle aurait pu enchaîner seul.

Claude Code a une réponse native, son code mode (outil `REPL`). Elle ne sert que Claude ; ce
module donne la même chose à tous les fournisseurs dont WorkPilot exécute les outils.

## Ce que fait `run_script`

Le modèle écrit un script (`await` au premier niveau, `return` de la valeur voulue) :

```js
const hits = await search("maxAttempts: 3", { glob: "**/*.yaml" });
const files = [...new Set(hits.split("\n").map((l) => l.split(":")[0]).filter(Boolean))];
await Promise.all(files.map((f) => edit(f, "maxAttempts: 3", "maxAttempts: 5")));
const [lint, tests] = await Promise.all([run("npm run lint"), run("npm test -- retry")]);
return { changed: files, tests: tests.split("\n").slice(-5) };
```

Fonctions : `read`, `search`, `find`, `list`, `write`, `edit`, `run`, `tool(name, args)` pour les
autres outils de la session (cerveau, `search_code`, vérification), `console.log`. La définition
(`code_mode/tool.py`) ne décrit que les fonctions dont le type d'agent a l'outil.

Le résultat lu par le modèle : la valeur rendue, la console, puis la liste des appels faits
(`[WorkPilot script calls]`, une ligne JSON par appel : outil, chemin ou commande, échec).

## Pourquoi le script n'ajoute aucun droit

Le script ne fait rien lui-même : chaque fonction est une ligne sur la sortie standard de Node,
à laquelle `code_mode/runner.py` répond après `executor.execute(outil, arguments)`, le chemin
d'un appel direct. S'y appliquent, appel par appel : les droits du type d'agent
(`executor_may_use`), le périmètre délégué (`allowed_tools`), les points d'arrêt de l'Agent
Debugger, le confinement des chemins et la configuration protégée (`_resolve_within_project`), les
garde-fous du projet, l'allowlist des commandes (`command_refusal`), rtk, les filigranes et le bac
à sable de l'OS de `run_command`. `edit` lit le fichier dans le runner (chemin résolu et confiné)
et écrit par `write_file`.

Ce que Node peut faire en dehors de ces requêtes est fermé à trois niveaux :

| Niveau | Ce qui est fermé |
|---|---|
| Processus | modèle de permissions de Node (`--permission`, `--experimental-permission` avant 22.13) : seule la lecture de `host.mjs` est permise ; aucune écriture, aucun processus, worker ni addon ; `process.binding` refusé |
| Code | `--disallow-code-generation-from-strings` et un contexte `vm` `codeGeneration: {strings: false, wasm: false}` : ni `eval`, ni `Function`, même atteint par le constructeur d'un objet de l'hôte |
| Contexte | aucun `require`, `process`, `fetch`, `import()` ni minuterie : les fonctions ci-dessus sont tout ce qu'il a |

S'y ajoutent l'environnement construit (`host_env` : `PATH` et les dossiers temporaires, aucun
identifiant), le bac à sable de l'OS autour de Node quand la session en a un, et des plafonds :
50 appels par script, 4 à la fois, 10 minutes (`WORKPILOT_CODE_MODE_TIMEOUT` les réduit), 256 Mo
de tas, 20 000 caractères de console. Un script ne s'appelle pas lui-même et ne délègue pas.

`tests/code_mode/test_runner.py` le prouve avec un vrai Node : constructeur, `eval`, `import()`
refusés, `fetch`, `require`, `process` absents ; un chemin hors projet, une écriture d'un
`pr_reviewer`, un appel récursif refusés ; les plafonds tenus.

## La surveillance des anomalies voit chaque appel

`agents/safety_watch.py` note ce que fait une session (fichiers écrits, commandes, hôtes joints)
d'après les appels du flux. Un script y est un seul appel : la watch lit donc sa liste d'appels
(`code_mode/protocol.py`) et note chacun comme un appel de la session, limites du bac à sable
comprises (nombre de fichiers écrits, chemins restreints, taille). Seul le dernier bloc compte,
celui que le runner écrit après la valeur du script : un script qui imprime un faux bloc peut
ajouter des appels à son relevé, jamais en cacher un. Un appel refusé ou en échec est noté comme
une erreur, sans contrôle d'écriture : rien n'a été écrit.

## Quand il est offert

| Source | Valeurs | Rôle |
|---|---|---|
| Paramètres, Mode code → `WORKPILOT_CODE_MODE` (`main/agent/code-mode-env.ts`) | `off` (défaut), `auto`, `on` | l'interrupteur : `off` coupe tout, quoi que dise la tâche |
| `task_metadata.json` : `codeMode` | idem | le choix de la tâche (le banc l'écrit sur sa copie) |
| `task_metadata.json` : `phaseCodeMode.{spec,planning,coding,qa}` | idem | le choix d'une phase, qui l'emporte |

`auto` ne l'offre qu'où il rapporte (`AUTO_AGENT_TYPES`) : codeur (sauf tâche `simple`), QA,
vérificateur, recherche de la spec, analyses du code. La rédaction de spec, la planification, les
revues et l'idéation font peu d'appels : un script n'y gagne rien. `on` l'offre à tout type qui
déclare des outils. `get_tool_definitions` et `_run_script` posent la même question
(`code_mode.offered`) : un modèle qui nomme l'outil sans qu'on le lui ait offert est refusé.

Le jeu d'outils d'une session est figé à son début (`harness.application.tools`) : un changement
de réglage vaut pour la session suivante.

## Mesuré par le banc

La doc de Claude ne chiffre aucun gain. Avant de changer un défaut, le banc de rejeu
([repo-bench.md](repo-bench.md)) rejoue chaque moteur deux fois, sans le mode code puis avec
(`codeMode: "on"` sur la copie ; le bras sans reçoit `codeMode: "off"`, explicite pour que
l'interrupteur de la personne ne décide d'aucun bras). Comme une règle candidate, une build en mode
code reste dans `results.json` sans atteindre le tableau, le routeur, Formula Lab ni les
recommandations ; la page du run compare chaque carte à sa jumelle : cartes résolues, régressions,
coût et durée moyens (`codeModeVerdict`). L'option n'est offerte que si l'interrupteur n'est pas
`off`, et jamais dans le même run qu'une règle.

## Le code mode natif de Claude Code (spike S2)

Lu dans le binaire de Claude Code 2.1.332 (messages de refus de `REPL`), le 27/11/2026 :

- `claude -p` et les applications Agent SDK **l'ont**, mais seulement quand
  `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1` est dans le bloc `env` de `--settings` (l'option
  `settings` du SDK) ; la variable dans l'environnement du shell ne suffit pas. Une valeur d'arrêt
  dans l'environnement, `~/.claude/settings.json` ou `~/.claude.json` l'emporte.
- En mode non interactif, seulement sur l'API Anthropic (abonnement ou `ANTHROPIC_API_KEY`) :
  refusé par un fournisseur cloud ou une passerelle, avec `apiKeyHelper`, `ANTHROPIC_AUTH_TOKEN` ou
  des en-têtes d'authentification, avec `CLAUDE_AGENT_SDK_MCP_NO_PREFIX`, quand `--tools`,
  `--disallowedTools` ou une règle `deny` retirent `REPL`, sous HIPAA, avec le traçage OpenTelemetry
  détaillé, sous Windows sans Git Bash, avec un modèle antérieur à Opus ou Sonnet 5.5 ; jamais en
  session cloud, distante ou préchauffée.
- Les appels faits dans `REPL` gardent leur nom (`Bash`…) : les hooks PreToolUse de WorkPilot
  s'y appliquent ; un hook `PreToolUse` sur `REPL` lit `tool_input.code`. Une session en code mode
  ne reprend qu'avec lui.

`create_client` passe déjà un fichier `settings` : c'est là que le lot B2 posera la variable, pour
une phase dont le réglage le demande et une tâche isolée, puisque le JavaScript de `REPL` tourne
hors du bac à sable des commandes. Le gain n'a pas pu être mesuré dans le conteneur cloud (refus
« entrypoint ») : il le sera par le banc, sur la machine de la personne.

## Ce qui ne change pas

- Interrupteur sur `off` (le défaut) : aucune définition de plus, aucun appel de plus, la boucle et
  ses prompts identiques à octet près.
- Changer de fournisseur ou de modèle : le jeu d'outils suit le client ; `run_script` ne dépend
  d'aucun LLM. Les CLI qui ont leurs propres outils (Claude Code, Codex, OpenCode, pi) ne le
  reçoivent pas.
- Pas de Node sur la machine : l'appel répond qu'il faut Node et que les autres outils restent.

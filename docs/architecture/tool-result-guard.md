# Garde des résultats d'outils (injection de prompt indirecte)

Un fichier que l'agent lit, une page qu'il récupère, la sortie d'une commande, la réponse d'un
serveur MCP : chacun vient de l'extérieur de WorkPilot et arrive au modèle comme la prochaine
chose qu'il lit. La règle S2 dit que c'est une donnée, jamais une instruction ; la garde est
l'endroit où cette règle rencontre chaque appel d'outil (#388).

Code : `apps/backend/security/tool_result_guard.py`, scanner `apps/backend/injection_guard/`,
lecture et écriture côté desktop `apps/frontend/src/main/ipc-handlers/injection-guard-tool-results.ts`.

## Où elle s'applique

| Provider | Point de passage |
|---|---|
| Boucle WorkPilot (OpenAI, Ollama et runtimes locaux, Windsurf, boucle Copilot…) | `core/agent_clients/base.py::run_tool`, le seul endroit où une boucle exécute un outil (exécuteur ou pont MCP) |
| SDK Claude | un hook `PostToolUse` (`core/client.py`) sur `Read`, `NotebookRead`, `Grep`, `Glob`, `WebFetch`, `WebSearch`, `Bash`, `BashOutput` et `mcp__*` |
| CLI qui exécutent leurs propres outils (Codex, Gemini CLI, OpenCode, pi…) | **non couverts** : leurs résultats ne passent pas par WorkPilot |

Les écritures et l'outil de sous-agent ne sont pas scannés : les premières rendent un statut, le
second est déjà encadré par `harness/application/subagents`. Le résultat d'une délégation
(`delegate`) non plus : c'est le texte d'un autre agent WorkPilot, dont les propres lectures ont
été gardées.

## Ce qu'elle fait

Le scanner (`injection_guard`) est déterministe : motifs, heuristiques, contenus encodés, sans
modèle ni appel réseau. Les motifs de contournement d'instructions couvrent l'anglais, le
français, l'espagnol, l'allemand, l'italien, le portugais, le chinois et le japonais. Un résultat
long est découpé en morceaux de 32 000 caractères qui se chevauchent de 512 ; au-delà de
24 morceaux, le début et la fin sont gardés et le milieu échantillonné régulièrement.

| Niveau | `warn` (défaut) | `block` |
|---|---|---|
| `safe` | transmis tel quel | transmis tel quel |
| `suspect` | avis + résultat encadré `<untrusted_tool_result source="…">` | idem |
| `blocked` | avis plus ferme + résultat encadré | **retenu** : le modèle lit une note qui nomme la source |

`WORKPILOT_TOOL_RESULT_GUARD=off` coupe l'analyse ; toute autre valeur vaut `warn`. Le défaut
n'est pas `block` parce que les tests d'un dépôt contiennent souvent « ignore previous
instructions » comme fixture : retenir est le choix de la personne.

Un `</untrusted_tool_result>` présent dans le contenu est neutralisé, il ne peut pas fermer la
clôture. Une analyse qui échoue transmet le résultat tel quel : la garde ne casse jamais un appel
d'outil.

### Claude : ce qu'un hook peut faire

Le CLI garde la sortie d'un outil intégré. En `warn`, le hook ajoute l'avis
(`additionalContext`) à côté du résultat. En `block`, il renvoie aussi `decision: "block"` avec
la raison, et `updatedToolOutput` : la même structure que la sortie, chaque chaîne qui se lit
comme une injection remplacée par l'avis. Le CLI vérifie la forme d'une sortie intégrée contre
son schéma : clés, types et chaînes inoffensives restent. S'il refuse quand même la forme, il
garde la sortie, et le refus atteint quand même le modèle.

## Source, sources de confiance

Chaque résultat a une source `type:valeur` :

| Type | Outils | Valeur |
|---|---|---|
| `path` | lecture, recherche | chemin relatif au projet |
| `host` | récupération web | nom d'hôte seul (jamais l'URL : elle porte des jetons) |
| `command` | shell | programme et sous-commande (`gh issue`), sans arguments (S1) |
| `tool` | MCP, recherche web, le reste | nom de l'outil |

`.workpilot/trusted-sources.json` (`{"sources": ["path:tests/fixtures/*", …]}`) liste les
sources transmises sans analyse. Motifs `fnmatch` insensibles à la casse, 200 caractères au plus,
100 entrées ; `*` seul ou un motif fait uniquement de jokers est refusé. La liste est lue dans le
checkout principal (`guardrail_policy.main_project`) : une tâche tourne dans un worktree, où
`.workpilot/` n'est pas extrait. Un lien symbolique n'est pas suivi.

Seul le processus main l'écrit, depuis la page Injection Guard, après revalidation avec les
mêmes règles (S6). Un agent ne peut pas l'écrire : `trusted-sources.json` est dans
`PROTECTED_CONFIG_DIRS[".workpilot"]` (`security/path_guard.py`), sinon il se mettrait lui-même en
confiance.

## Alertes

Chaque résultat signalé ajoute une ligne à `<spec_dir>/injection_alerts.jsonl` :
`{at, tool, source, level, findings, action}`, **sans contenu**. Les boucles l'écrivent dans le
dossier de spec de leur exécuteur, Claude dans celui du client. La page Injection Guard lit les
alertes de toutes les tâches du projet, dossiers de spec principaux et de worktree, sans doublon,
les plus récentes d'abord (200 au plus, fichiers de plus de 2 Mo ignorés).

## Limites

- Pas de classifieur ML ni de juge LLM : une injection reformulée hors des motifs passe.
- Les CLI qui exécutent leurs propres outils ne sont pas couverts.
- En mode serveur, la page n'existe pas : les alertes restent dans les dossiers de spec.

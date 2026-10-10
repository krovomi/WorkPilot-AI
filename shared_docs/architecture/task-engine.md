# Le moteur d'une tâche et le LLM d'une page

> Design rationale moved verbatim out of [`docs/CLAUDE.md`](../../docs/CLAUDE.md),
> which stays the normative file: where the two disagree, `docs/CLAUDE.md` wins.

## Le moteur d'une tâche (`shared/utils/task-engine.ts`)

Une tâche du Kanban ne possédait pas son moteur. Le formulaire de création ne
proposait aucun fournisseur et écrivait celui de la liste « Fournisseur IA » du
header ; `syncTaskProvider` le remplaçait par celui du projet ou du header à
chaque démarrage, passage en QA et reprise ; le sous-processus recevait les
identifiants et le `SELECTED_LLM_PROVIDER` du header, que
`_resolve_active_provider` faisait passer **avant** `task_metadata.json` ; et
changer la liste réécrivait les métadonnées de toutes les tâches
(`applyProviderToTasks`). Une tâche créée pour Ollama tournait donc sur ce que
la barre du haut affichait ce matin-là.

Le moteur — Fournisseur × LLM × Effort, **par phase** (spec, planification,
code, QA) — appartient désormais à la tâche, et `engineLocked: true` dans
`task_metadata.json` est ce qui le dit à tout le monde :

| Qui | Ce qu'il fait d'une tâche verrouillée |
|---|---|
| `shared/utils/task-engine.ts` | la seule réponse à « avec quoi tourne cette tâche » : `resolveTaskEngine`, `seedEngine`, `buildEngineMetadata` (les quatre phases toujours écrites), `applyEngineChange` |
| `main/agent/task-provider-env.ts` | l'environnement du sous-processus : les identifiants de **chaque** fournisseur que ses phases utilisent, `SELECTED_LLM_PROVIDER` de la phase de départ. Claude n'y est jamais re-déclaré — sa chaîne OAuth / profils API reste celle du process manager |
| `agent-manager` / `execution-handlers` | l'exigence d'authentification Claude, le refresh OAuth et le démarrage d'Ollama suivent les phases de la tâche, plus le header |
| `ensureTaskEngine` | remplace `syncTaskProvider` : ne touche jamais une tâche verrouillée, migre une fois une tâche d'avant (chaque phase garde ce que la tâche nommait, le reste vient des préréglages de ce fournisseur) |
| `core/client._resolve_active_provider` | le fournisseur de la tâche répond avant le marqueur `RESUME_WITH_PROVIDER` et avant `SELECTED_LLM_PROVIDER` ; sans verrou, l'ordre d'avant est inchangé |
| `phase_config.get_phase_model` | lit `phaseModels[phase]` sans exiger `isAutoProfile` |
| `agents/coder.py`, `spec/pipeline/agent_runner.py` | nomment toujours le fournisseur **de la phase** |

**Le choisir, le voir, le changer — sur la tâche.** `TaskEngineEditor`
remplace le bloc de profil d'agent dans la création et l'édition : un trio pour
toute la tâche et, sous « Avancé », un par phase, fournisseur compris. Il part
du fournisseur du projet, sinon du fournisseur par défaut, avec les préréglages
de ce fournisseur (Paramètres → Agent). `TaskEngineChip` l'affiche sur chaque
carte. `EngineTrioPicker` est le seul trio de sélecteurs : création, édition,
phase, reprise.

**La reprise s'applique à la phase reprise et aux suivantes.** En pause,
`TaskPauseControls` part du moteur de la phase interrompue ; « Seulement pour la
phase reprise » limite le changement à elle (`scope: "phase"`). Les phases déjà
derrière gardent ce sur quoi elles ont tourné : c'est leur historique, pas un
réglage. `TASK_RESUME_WITH_PROVIDER` écrit le moteur dans **chaque** copie de
`task_metadata.json` (worktree comprise), n'écrit plus le marqueur à usage
unique — qu'une deuxième session perdait — et relance par `resumePausedTask`,
le chemin du bouton Reprendre : mode TDD, cibles mobiles et retour au pipeline
de spec conservés, ce que `restartTaskWithNewProvider` perdait. La session
Claude n'est réhydratée que si la phase reprise reste sur Claude ; sinon le
journal de conversation passe le contexte au nouveau modèle de la même phase,
pour tous les fournisseurs.

**Le fournisseur par défaut n'est pas un pilote.** La liste a quitté le header :
c'est « Fournisseur par défaut » dans Paramètres → Agent (et la carte activée
dans Comptes IA). Elle amorce les nouvelles tâches et répond pour les
fonctionnalités sans sélecteur propre (`getGlobalProviderEnv`, `page-llm.ts`) ;
elle ne modifie jamais une tâche existante. Les badges de consommation ont leur
propre objectif, `UsageLensSelector` : « Automatique » suit le fournisseur des
phases en cours, ou la personne en choisit un — ce qui ne change que ce que les
badges affichent. `ProviderContext` porte les deux réponses, `selectedProvider`
(le défaut) et `usageProvider` (l'objectif des badges).

## Provider × LLM × effort, par page (`shared/utils/page-llm.ts`)

Une page qui lance un agent posait la question deux fois et n'en gardait qu'une
moitié : le modèle et l'effort venaient de `featureModels` / `featureThinking`,
et le fournisseur ne venait de *nulle part*. La liste « Fournisseur IA » qui
était alors en haut à droite ne servait qu'aux builds du Kanban, si bien qu'une revue de PR repartait
sur Claude alors que l'utilisateur avait choisi Copilot une seconde plus tôt —
`getRunnerEnv()` n'injectait aucun `SELECTED_LLM_PROVIDER`.

`shared/utils/page-llm.ts` est l'unique réponse à « avec quoi cette page
tourne-t-elle ? », et l'ordre est celui déjà établi, une source par cran :

| Ce qui décide | Fournisseur | Modèle | Effort |
|---|---|---|---|
| 1. la page (`pageLlmOverrides[page]`) | ✔ | ✔ | ✔ |
| 2. les réglages (`selectedProvider`, `featureModels`, `featureThinking`) | ✔ | ✔ | ✔ |
| 3. les défauts du dépôt (`DEFAULT_FEATURE_*`) | — | ✔ | ✔ |

Un cran vide n'en consomme pas un autre : une page qui ne nomme que le
fournisseur garde le modèle et l'effort des réglages, et une page qui ne nomme
rien se comporte comme avant. Le champ absent est **retiré** de
`pageLlmOverrides` plutôt que stocké vide — c'est ce qui garde « aucun choix » et
« le même choix que les réglages » distincts, et qui fait qu'un changement de
fournisseur global bouge bien les pages qui n'ont rien demandé.

Quand un **fournisseur** est choisi sur la page ou globalement, sans modèle
explicite sur la page, le modèle hérité des
réglages est ramené au catalogue de ce fournisseur
(`resolveModelForProviderCatalog`) : il peut encore désigner le fournisseur
global, et demander `claude-opus-4-6` à Ollama échoue à l'appel, avec un message
qui parle d'un modèle inconnu plutôt que du choix.

**Le jeu de pages est fermé** (`PAGE_LLM_FEATURES`). Une page y entre le jour où
son runner lit la réponse ; un sélecteur qui promet ce que le runner ignore est
pire que pas de sélecteur. Aujourd'hui : `insights`, `ideation`, `roadmap`,
`github-issues`, `github-prs`, `gitlab-merge-requests`, `prompt-optimizer`,
`natural-language-git`. Les fonctionnalités qui ont un réglage de modèle mais
aucun lecteur (`testGenerator`, `codeReview`, `voiceControl`, `utility`) n'en
font pas partie — le Kanban, lui, a déjà sa formule *par tâche*.

| Qui lit | Où |
|---|---|
| le renderer, pour afficher ce que la page va faire | `resolvePageLlm` (`PageLlmSelector`, `natural-language-git-store`) |
| le main, pour `--model` / `--thinking-level` | `getPageFeatureSettings` (`main/services/page-llm-config.ts`) |
| le main, pour `SELECTED_LLM_PROVIDER` + la clé | `getPageProviderEnv`, puis `credentialManager.getEnvironmentVariables(provider)` |

Les sept `getXxxFeatureSettings()` qui recopiaient la même lecture de
`settings.json` dans autant de handlers sont ce module ; `getRunnerEnv` prend
désormais `{ page }` et ajoute l'environnement du fournisseur de la page. Le
backend n'a rien à apprendre : `core.client._get_active_provider` honore déjà
`SELECTED_LLM_PROVIDER`.

**Le fournisseur reste vide quand personne n'en a choisi** — et non « Claude ».
Le backend a sa propre chaîne de résolution, et y écrire un nom la
court-circuiterait avec une valeur que personne n'a demandée.

**Une surface hors du jeu fermé suit quand même le fournisseur par défaut.**
Le jeu fermé dit quelles pages ont une *formule propre* ; il ne dit pas
lesquelles ont le droit d'ignorer le choix global. `getRunnerEnv()` appelé sans
`page` n'injectait aucun `SELECTED_LLM_PROVIDER` du tout, si bien que la
génération de tests, l'auto-fix GitHub et l'auto-réparation repartaient sur le
défaut du backend pendant que la barre du haut affichait autre chose — le même
symptôme que celui que ce module existe pour corriger, un cran plus bas. Sans
`page`, `getGlobalProviderEnv()` répond : exactement ce qu'une page sans
surcharge reçoit.

Dans l'UI, `PageLlmSelector` vit dans la barre sticky, et n'est pas un doublon
du fournisseur par défaut (Paramètres → Agent) : celui-là dit avec quoi
l'application travaille quand personne n'a rien précisé, celui-ci dit avec quoi
*cette page* travaille. Il n'affiche rien sur une page hors du jeu fermé — le
Kanban compris, où chaque tâche a son propre moteur.

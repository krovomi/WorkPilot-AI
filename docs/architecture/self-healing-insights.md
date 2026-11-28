---
feature: Auto-guérison — tendances, groupes, bisect
summary: >-
  Trois lectures déterministes avant tout correcteur : la trajectoire du risque de chaque fichier
  d'un scan à l'autre, une empreinte qui fait d'un bug vu par plusieurs outils un seul incident,
  et un bisect dans un worktree temporaire qui nomme le premier commit fautif. Aucun appel LLM.
---

# Auto-guérison : tendances de risque, groupes d'incidents, bisect (#370, #372, #375)

Les trois modes de l'auto-guérison (`apps/backend/self_healing/incident_responder/`) jugeaient
chaque signal isolément : un score de fragilité à l'instant du scan, un rapport de production par
événement, le dernier commit comme coupable d'un échec de CI. Ces trois lots ajoutent le contexte
qui manquait, **calculé, jamais estimé par un modèle** : les chiffres viennent de l'historique
des scans, de la pile d'appels et de git. Le prompt du correcteur reçoit ensuite ces faits.

| Mode | Module | Ce qu'il ajoute |
|---|---|---|
| Proactif | `self_healing/proactive/` | historique des scans, trajectoire par fichier, liste chaude, dossiers qui se dégradent |
| Production | `self_healing/production/` | empreinte, groupe d'incidents, commits suspects, héritage de priorité |
| CI/CD | `self_healing/cicd/` | déclencheurs, dernier commit vert, bisect, section « premier commit fautif » du prompt |

Les modules de `incident_responder/` importent `from ..production import grouping` (l'objet
module) : les `__init__.py` des nouveaux paquets n'importent rien, ce qui évite le cycle avec
`incident_responder/models.py`.

## Tendances de risque (`proactive/`)

- **Historique** (`history_store.py`) : `.workpilot/self-healing/health_history.sqlite`, table
  `snapshot(day, file, risk, complexity, churn, coverage)`. Un instantané par jour UTC (un second
  scan le même jour remplace le premier), 120 jours gardés, 5 000 fichiers au plus par
  instantané. Une base illisible donne un historique vide, jamais une erreur.
- **Tous les fichiers mesurés sont enregistrés**, pas seulement ceux au-dessus du seuil : un
  fichier qui monte doit avoir un passé. La découverte des fichiers (`fragility_analyzer.py`)
  est triée et élague les dossiers exclus, pour que deux scans mesurent les mêmes fichiers ;
  les extensions couvrent les langages courants.
- **Trajectoire** (`trajectory.py`) : pente par moindres carrés en points de risque par semaine
  sur 90 jours. Moins de 4 points : `new`. Montée rapide : pente ≥ 4 (ou moitié récente ≥ 4 et
  pente ≥ 1) et +10 points ; montée lente : pente ≥ 1 et +3 ; amélioration : l'inverse ; sinon
  stable. Une chute de 30 points d'un coup (réécriture) remet l'historique à zéro.
  `entered_hot` ne vaut qu'au scan où le fichier devient rapide.
- **Dossiers** (`clusters.py`) : au moins 2 fichiers en montée qui font au moins la moitié des
  fichiers suivis du dossier.
- L'UI (`ProactiveHotlist.tsx`, `RiskTrajectoryChart.tsx`) lit `riskTrends` du tableau de bord.

## Groupes d'incidents de production (`production/`)

- **Empreinte** (`fingerprint.py`) : sha256 tronqué du type d'erreur normalisé (`builtins.`,
  espaces de noms et casse retirés), du fichier et de la fonction du frame le plus interne
  *du dépôt* (lu par `docintel.stacktrace`, numérotation des runtimes retirée), du service et de
  la version. Les numéros de ligne n'y entrent pas : déplacer du code garde l'empreinte. Sans
  frame du dépôt, le message normalisé (nombres, identifiants, chaînes retirés) la remplace.
- **Un groupe = une tentative de correction** (`grouping.py`) : un rapport dont l'empreinte est
  celle d'un incident ouvert y est replié (`orchestrator._file_production_incident`) et rien
  d'autre ne se lance. Un incident résolu ou en PR n'avale pas une récidive. Pour un même
  identifiant externe, les compteurs sont cumulatifs (on garde le maximum) ; entre outils, on
  prend l'outil qui compte le plus, pas la somme de deux outils qui comptent le même crash.
  200 rapports au plus par groupe ; au-delà, l'événement compte quand même.
- **Commits suspects** (`suspects.py`) : `git log` depuis le dernier tag sur les fichiers des
  frames, pondérés par leur profondeur. Un nom de fichier qui commence par `/` ou `-`, ou qui
  contient `..`, n'atteint jamais git.
- **Héritage de priorité** : les incidents ouverts dont le premier suspect est le même commit
  forment un cluster ; tous prennent la gravité la plus haute du cluster (critique à partir de
  10 incidents, haute à partir de 5).
- Le texte venu de l'outil de supervision est du contenu externe (règle S2) : message, pile et
  sujets de commit passent par `security/untrusted.py` avant le prompt.

## Bisect d'un échec de CI (`cicd/`)

- **Déclencheurs** (`triggers.py`) : diff du commit en échec de moins de 10 lignes, test en échec
  pas touché depuis 30 jours, fichier de dépendances modifié dans l'intervalle (toutes stacks).
  Un seul suffit, et seulement si un commit vert est connu.
- **Dernier commit vert** (`green.py`) : `.workpilot/self-healing/last_green.json`, par branche,
  écrit quand le runner voit la suite passer.
- **Bisect** (`bisect.py`) : les deux bouts sont des identifiants hexadécimaux (ni ref, ni
  option, ni intervalle), résolus par git, et le vert doit être un ancêtre du rouge. La recherche
  se fait dans un `git worktree add --detach` temporaire (les dossiers de dépendances du projet y
  sont liés, puis déliés avant la suppression) : la copie de travail, `HEAD` et la liste des
  worktrees restent identiques. La commande est celle que `suite_runner` détecte pour la stack,
  lancée sans shell et sans identifiants, sur les tests en échec seulement quand le framework
  sait les nommer. Avant de chercher : le rouge doit échouer, échouer encore deux fois (sinon
  `flaky`), et le vert passer (sinon `good_fails`). Budget : 16 exécutions, 30 minutes,
  10 minutes par exécution ; un commit qu'on ne peut pas tester est sauté et peut laisser un
  intervalle (`ambiguous`). Les verdicts trouvés sont mis en cache par intervalle et tests.
- **Le correcteur lit le bon diff** (`flow.py`) : un commit trouvé devient `regression_commit`
  et son diff remplace celui du dernier commit ; `{{FIRST_BAD_COMMIT}}` explique au correcteur
  ce que le bisect a trouvé, ou pourquoi il ne l'a pas fait.
- **À la demande** : le canal IPC `selfHealing:bisect` prend un id d'incident et, en option, un
  commit vert. Le main (`self-healing-bisect-handlers.ts`) revérifie les deux formes, le dossier
  de projet passe par `DIRECTORY_ARGS`, le runner reçoit `pythonRunnerEnv` et chaque commit testé
  est renvoyé à la fenêtre (`selfHealing:bisectProgress`) après validation.

## Ce que les handlers acceptent

`main/ipc-handlers/self-healing-inputs.ts` vérifie ce que la page envoie avant que le runner
parte ou que `.workpilot/self-healing/config.json` soit écrit : un id d'incident ou d'opération
qui commence par une lettre ou un chiffre, un mode et une source en listes fermées, des réglages
plats (booléens, nombres, textes courts, listes de textes). Une source de production ne garde
que les quatre champs que le runner lit, son URL en http(s), et sa configuration passe au runner
sur stdin (`--config -`), pas dans ses arguments. Le lien vers la PR d'un incident n'est rendu
que pour une URL http(s) (`shared/utils/web-link.ts`).

## Ce qui reste

- #370 : explication en langage naturel d'une trajectoire, notification à l'entrée dans la liste
  chaude, spec de refactor préventif vers la Roadmap, historique amorcé depuis git.
- #372 : fusion manuelle de groupes, seuil de similarité, propriétaires, adaptateurs par outil.
- #375 : choix du prochain commit par un agent, budget de coût, déclencheur « motif d'erreur
  jamais vu », rejouer un test ajouté contre l'ancien code.

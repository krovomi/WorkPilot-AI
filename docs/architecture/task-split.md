# Découpage automatique d'une grosse tâche (`task_split`)

Une tâche du Kanban peut produire une PR de 3 000 lignes, trop longue à relire. Après la
planification, et avant la première ligne de code, WorkPilot mesure le plan. S'il dépasse le
plafond de lignes (ou de fichiers) du projet ou de la tâche, la tâche devient N petites tâches,
chacune avec sa propre PR. Le découpage ne dépend ni du fournisseur, ni du modèle, ni de la stack :
il lit seulement `implementation_plan.json`.

```
apps/backend/task_split/
  policy.py     plafonds par type de tâche : carte > paramètres du projet (env) > défauts ; on/off
  review_load.py  lignes à relire : poids par type de fichier, toutes stacks (pur)
  slices.py     découpe pure du plan en parts (aucune E/S)
  children.py   écrit les cartes enfants, clôt et archive la tâche découpée
  step.py       le point d'appel du build ; une erreur garde la tâche entière
  diff_check.py après la QA : le diff réel de la branche contre le plafond (splitCheck)
  group.py      couleur (hash), label, préfixe de titre, section « Groupe de PR » (pur)
apps/backend/core/pr_group.py  ces marques posées à la création de la PR ; label gh / glab
apps/frontend/src/shared/utils/task-split.ts               lecture des métadonnées, plafonds
apps/frontend/src/main/ipc-handlers/task/split-events.ts   TASK_SPLIT → tableau rechargé
apps/frontend/src/main/ipc-handlers/task/split-stack.ts    une part dépendante empilée (F6)
apps/frontend/src/main/ipc-handlers/task/split-merge-watch.ts  PR fusionnée → part terminée, parts empilées déplacées
apps/frontend/src/main/pr-state.ts                         état d'une PR : GitHub (gh), GitLab (glab), Azure DevOps (REST)
apps/frontend/src/renderer/components/kanban/SplitPartBadge.tsx   badge de groupe (filtre au clic), « 620 / 400 lignes »
apps/mobile/src/board/splitGroup.ts                        la même couleur sur le téléphone
```

## Le plafond, selon le type de tâche

Le plafond compte les **lignes à relire** (`review_load.py`), pas les lignes modifiées :

| Fichier | Poids d'une ligne |
|---|---|
| code | 1 |
| tests, documentation | 0,5 |
| fichiers générés, vendorisés, lockfiles (npm, pnpm, yarn, Poetry, uv, Cargo, Go, Composer, NuGet, CocoaPods, pub…), snapshots de tests | 0 |
| ligne supprimée | le quart du poids de son fichier ; un fichier supprimé entier compte pour 1 |

Les fichiers à poids nul ne comptent pas non plus dans le plafond de fichiers. Le type de fichier se
lit au chemin seul, avec les conventions de test de toutes les stacks (`foundation/test_conventions`).
Le demi-poids des tests et de la doc est un choix : aucune étude ne le chiffre.

Le plafond dépend du **type** de la tâche (`tasks/classify.py` : catégorie, type de l'item importé,
mots du titre, sans token). Les valeurs viennent des études sur la revue de code. Chez SmartBear
(équipe Cisco), au-delà de 200 à 400 lignes, de 500 lignes par heure ou de 60 minutes, le
relecteur trouve moins de défauts. Pour Google, 100 lignes est raisonnable et 1 000 trop.

| Type | Lignes à relire par PR |
|---|---|
| correctif urgent (`hotfix`) | 100 |
| correction de bug (`bug_fix`) | 200 |
| feature | 400 (une séance de revue au plus) |
| refactoring | 300 |
| mise à jour de version (`upgrade` : framework, SDK, dépendances) | 200 |
| tests (`test`), documentation (`docs`) | 400 |
| investigation, spike, exploitation (`run`) | jamais découpé : pas de code à relire |

| Source | Clés | Portée |
|---|---|---|
| Tâche | `noSplit`, `splitMaxLines` (métadonnées de la carte, formulaire de tâche) | cette tâche, quel que soit son type |
| Projet | `settings.autoSplit` → `WORKPILOT_SPLIT_MAX_LINES_BY_KIND` (JSON type → lignes), `WORKPILOT_SPLIT_MAX_LINES` (tous types), `WORKPILOT_SPLIT_MAX_FILES`, `WORKPILOT_AUTO_SPLIT` | toutes ses tâches |
| Défaut | le tableau ci-dessus, 25 fichiers | partout |

Une valeur hors bornes (lignes 50 à 20 000, fichiers 2 à 1 000) est ignorée et la source suivante
s'applique. Un projet qui coupe le découpage l'emporte : une tâche ne peut pas le rallumer seule.
Une tâche d'un type jamais découpé l'est si elle porte son propre plafond. Le type retenu est
écrit dans `splitGroup.kind` de la tâche découpée.

## La mesure et la découpe (`slices.py`)

- **Poids d'une sous-tâche** : `estimated_lines` si le planificateur l'a donné (le prompt le
  demande), multiplié par le poids moyen de ses fichiers ; sinon 80 par fichier créé, 30 par
  fichier modifié, chacun pondéré, et 20 sans fichier. C'est une estimation : la vérification sur
  le diff réel arrive dans un lot suivant.
- **Unités** : les phases du plan restent entières. Une phase plus lourde que le plafond est
  coupée en tronçons enchaînés « Nom (k/n) ».
- **Dépendances** : `depends_on` du plan. Une phase sans `depends_on` dépend de la précédente ; une
  phase d'intégration, de vérification ou de test dépend de toutes les précédentes ; une référence
  inconnue vaut « toutes les précédentes ». On ne suppose jamais l'indépendance.
- **Regroupement** : glouton dans l'ordre du plan, sans dépasser le plafond, en respectant les
  étiquettes `slice` que le planificateur peut poser sur ses phases. Au plus 10 parts : au-delà, le
  plafond double jusqu'à ce que le plan tienne.
- **Rien à couper** : une seule part, ou une sous-tâche déjà commencée, et la tâche reste entière.

## Les cartes (`children.py`)

Chaque part `k` devient une carte sœur `<tâche>-part<k>` (raccourcie pour rester un id de carte
serveur valide). Son dossier de spec est une copie de celui de la tâche, sans les sorties de build,
avec :

- une note en tête de `spec.md` : « Part k of N », ce qu'elle couvre, ce qui reste aux autres ;
- un plan qui ne garde que ses phases, `status: queue` ;
- `splitGroup {parent, title, index, total, name}` et `blockedBy` = la part dont elle dépend ;
- l'approbation de la spec reprise (`approved_by: auto-split`), car la tâche d'origine l'était.

La tâche d'origine reçoit `splitGroup {children, total, maxLines, source}` et `archivedAt`. Son plan
passe `done` : elle quitte le tableau et ne compte plus dans la file. Un dossier enfant déjà présent
annule tout (`SplitError`) et la tâche est construite entière.

## Le point d'appel

`split_before_build` tourne dans `cli/build_commands.py` avant la création du worktree, quand le
plan existe déjà. `raise_if_split` tourne dans le coder juste après la validation du plan du
planificateur ; il lève `BuildSplit` et le build retire son worktree. Les deux émettent
`TASK_SPLIT` (`{parent, total, maxLines, children}`), un événement terminal de la machine d'état.

L'app reçoit d'abord les métadonnées de la tâche (pour que son « terminé » ne soit pas annoncé comme
un build fini), puis recharge le tableau et relance la file : les parts sans prérequis partent tout
de suite, en parallèle, depuis la branche de base.

## Les parts qui dépendent l'une de l'autre

Une part dont le prérequis (une part du même découpage) a passé la QA peut démarrer sans attendre
la fusion (`canStartOnSibling`). Au démarrage, et seulement avant la création de son worktree, elle
est empilée sur ce prérequis par les tâches empilées (F6, [stacked-tasks.md](stacked-tasks.md)) :
son worktree part de la branche de la part précédente et sa PR la vise. Si l'empilement échoue, le
démarrage est refusé avec un message qui dit quoi faire. Une part dont le prérequis est fusionné
part de la base comme une tâche ordinaire. Une carte serveur n'est pas empilée (git tourne sur ce
poste) : elle attend la fusion de son prérequis.

## Quand la PR d'une part est fusionnée

Toutes les 3 minutes (la première minute après le lancement), l'app lit l'état de la PR de chaque
part locale qui attend sa revue (`pr_created` ou `human_review`, avec une `prUrl`) : `gh pr view`
sur GitHub, l'API de `glab` sur GitLab, l'API REST avec le jeton du projet sur Azure DevOps. L'URL
vient des métadonnées, qu'un agent écrit : elle doit avoir la forme exacte de son forge et passe en
un seul argument. Une réponse illisible vaut « inconnu », jamais « fusionnée ».

- **Fusionnée** : la part passe `done` (`prMergedAt` dans ses métadonnées).
- **Les parts empilées dessus** passent sur sa base par `stackUpdate` (F6) : `git rebase --onto
  <base> <ancien commit de la part>`, qui tient après une fusion squash, puis `gh pr edit --base`.
  Pas pendant qu'un agent tourne, ni sur un worktree modifié : le passage suivant réessaie. Un
  conflit annule le rebase et n'est retenté qu'une fois la part déplacée ; la personne le résout
  depuis le panneau d'empilement de la carte.
- Le tableau est rechargé et la file relancée (`TASK_SPLIT`) : une part qui attendait cette fusion
  démarre depuis la base.
- **Fermée sans fusion**, forge muet : rien ne change. Une carte serveur n'est pas suivie ici, ni un
  projet en mode hors-ligne strict (`.workpilot/offline-mode.json`, illisible compris).

## Le diff réel, après la QA (`diff_check.py`)

Le découpage décide sur l'estimation du plan. Une fois la QA passée, `git diff --numstat -z -M
<base>...HEAD` du worktree est pesé comme le plan (`review_load.py`, un fichier supprimé compte
pour 1) et comparé au plafond de la carte. Le résultat va dans `splitCheck {lines, files,
maxLines, maxFiles, kind, over}` des deux copies des métadonnées, et la carte au-delà du plafond
porte « 620 / 400 lignes » (ou « 31 / 25 fichiers »). Rien n'est redécoupé : le code est écrit. Une
carte jamais découpée (son type, `noSplit`, le projet) n'est pas mesurée.

## Reconnaître les PR d'un groupe

Le groupe est la tâche découpée (son dossier de spec). Sa couleur est l'un des six tons de la
charte (bleu, violet, vert, ambre, rose, orange ; le rouge reste aux erreurs), choisi par un hash
FNV-1a de cet id : le bureau (`splitGroupTone`), le téléphone (`groupTone`) et le backend
(`group_tone`) calculent le même, sans rien stocker. La couleur n'est jamais le seul signe : la
marque est aussi écrite.

| Surface | Marque |
|---|---|
| Kanban | badge « Partie 2/4 · OAuth Google » dans la couleur du groupe ; un clic n'affiche que le groupe (`filters.group`), un second clic ou la puce de la barre d'outils affiche tout |
| Téléphone | la même marque sur la carte (`group` de `GET /api/board/cards`), un appui filtre la colonne |
| GitHub, GitLab | titre `[OAuth Google 2/4] API`, label `groupe/<id du groupe>` créé dans la couleur du groupe, section « Groupe de PR » en fin de description |
| Azure DevOps | titre et section (pas de label de PR fiable) |

La section dit quelle part relire d'abord et liste les parts avec leur PR quand elle est ouverte.
Elle suit la langue de l'app (`APP_LANGUAGE`). Le label est posé après la création de la PR : un
échec est écrit au journal et n'annule jamais la PR.

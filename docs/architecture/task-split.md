# Découpage automatique d'une grosse tâche (`task_split`)

Une tâche du Kanban peut produire une PR de 3 000 lignes, trop longue à relire. Après la
planification, et avant la première ligne de code, WorkPilot mesure le plan. S'il dépasse le
plafond de lignes (ou de fichiers) du projet ou de la tâche, la tâche devient N petites tâches,
chacune avec sa propre PR. Le découpage ne dépend ni du fournisseur, ni du modèle, ni de la stack :
il lit seulement `implementation_plan.json`.

```
apps/backend/task_split/
  policy.py     plafonds : carte > paramètres du projet (env) > défauts ; on/off
  slices.py     découpe pure du plan en parts (aucune E/S)
  children.py   écrit les cartes enfants, clôt et archive la tâche découpée
  step.py       le point d'appel du build ; une erreur garde la tâche entière
apps/frontend/src/shared/utils/task-split.ts               lecture des métadonnées, plafonds
apps/frontend/src/main/ipc-handlers/task/split-events.ts   TASK_SPLIT → tableau rechargé
apps/frontend/src/main/ipc-handlers/task/split-stack.ts    une part dépendante empilée (F6)
apps/frontend/src/renderer/components/kanban/SplitPartBadge.tsx
```

## Le plafond

| Source | Clés | Portée |
|---|---|---|
| Tâche | `noSplit`, `splitMaxLines` (métadonnées de la carte, formulaire de tâche) | cette tâche |
| Projet | `settings.autoSplit` → `WORKPILOT_AUTO_SPLIT`, `WORKPILOT_SPLIT_MAX_LINES`, `WORKPILOT_SPLIT_MAX_FILES` | toutes ses tâches |
| Défaut | 400 lignes modifiées, 25 fichiers | partout |

Une valeur hors bornes (lignes 50 à 20 000, fichiers 2 à 1 000) est ignorée et la source suivante
s'applique. Un projet qui coupe le découpage l'emporte : une tâche ne peut pas le rallumer seule.

## La mesure et la découpe (`slices.py`)

- **Poids d'une sous-tâche** : `estimated_lines` si le planificateur l'a donné (le prompt le
  demande), sinon 80 par fichier créé, 30 par fichier modifié, 20 sans fichier. C'est une
  estimation : la vérification sur le diff réel arrive dans un lot suivant.
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

## Ce qui reste à faire

- Détecter la fusion d'une PR de part et mettre à jour les parts empilées dessus.
- Mesurer le diff réel après le code et le comparer au plafond.
- Couleur de groupe et étiquette `groupe/<nom>` sur le Kanban, le mobile, GitHub, GitLab ; préfixe
  `[Tâche k/N]` et section « Groupe de PR » sur Azure DevOps aussi.

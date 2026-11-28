---
feature: Bilan d'une tâche terminée (coût, durée, auteurs)
summary: >-
  Une carte finie montre le temps des agents, les tokens et le coût de leurs sessions (tous
  providers, « inconnu » si rien n'est compté), son créateur et son lanceur : `main/task-run-facts.ts`
  lit le relevé et `task_people.json`, les durées viennent de `status_history.json`, le serveur les
  calcule depuis sa base sans les écrire.
---

# Bilan d'une tâche terminée

Demande de Leub (27 novembre 2026) : une tâche finie du Kanban doit dire combien de tokens elle a
coûté, le temps qu'elle a pris, la personne qui l'a créée et celle qui l'a lancée, qui ne sont pas
forcément la même.

## Ce que la carte montre

`renderer/components/kanban/TaskRunFacts.tsx`, sur une carte dont les agents ont fini
(`isTaskEffectivelyComplete` : terminée, PR ouverte, revue achevée par les agents) :

- **la ligne de la carte** (`TaskRunFactsRow`, sous les badges) : temps de travail des agents,
  tokens (`≈` quand une session a été estimée) et coût quand quelqu'un l'a chiffré, puis
  « Alice » quand la même personne a créé et lancé la tâche, « Alice → Bob » sinon ; l'infobulle
  et le texte pour lecteur d'écran disent « Créée par Alice, lancée par Bob » ;
- **l'aperçu au survol** (`TaskRunFactsDetails`, dans `TaskCardPreview`) : en plus, le délai du
  lancement à la fin, le détail entrée / sortie / cache, les modèles les plus utilisés et le
  nombre de sessions estimées.

Ce que personne n'a compté s'affiche « inconnu », jamais 0 : un 0 laisserait croire qu'une tâche
n'a rien coûté.

## Les durées

`shared/utils/task-run-duration.ts`, lu sur `Task.statusHistory`
([task-status-history.md](task-status-history.md)) : des durées **mesurées**, jamais estimées.

| Durée | Calcul |
|---|---|
| Temps de travail des agents | la somme des passages « En cours » et « Revue IA », chaque run compris ; l'attente en file, en revue humaine ou au backlog ne compte pas |
| Du lancement à la fin | du premier passage « En cours » au dernier passage à un état fini |

Une tâche plus ancienne que l'historique, ou jamais lancée, n'a pas de durée : « inconnu ».

## La consommation

Chaque session d'agent, quel que soit le provider, passe par `core/usage_tracker.record_session_usage`,
qui l'ajoute au relevé `<projet>/.workpilot/cost_data.json` (tokens, cache, coût du provider ou du
catalogue, `usage_source: "estimated"` quand le provider n'a rien compté et que le texte a servi).
Le processus principal additionne ce relevé par carte (`usageBySpec`), à la racine et dans les
workspaces de tâche encore présents (`workspace-ledgers.ledgerDirs`, pour les builds d'avant
#876). Le relevé est relu seulement quand il change (date et taille) ; la liste des tâches du
main est gardée 3 s en cache.

Une carte sans session, ou dont les sessions n'ont rien rapporté (ni token ni prix) : consommation
inconnue (`knownUsage`). Un coût à 0 avec des tokens (modèle local, provider non chiffré) : les
tokens s'affichent, le coût non.

## Tenu à jour pendant la session

Le main calcule le bilan quand le renderer lit le tableau (`TASK_LIST`) ; un changement de statut,
lui, ne modifie que le statut de la carte dans le store (`updateTaskStatus`). Sans relecture, une
carte créée et finie pendant la même session gardait l'état de son premier chargement : toutes
les lignes du bilan disaient « inconnu » jusqu'au redémarrage de l'app (constaté par Leub le
28 novembre 2026, avec Claude comme avec tout autre provider).

`renderer/stores/task-run-facts-refresh.ts`, enregistré par `global-listeners.ts`, écoute chaque
changement de statut d'une carte et relit le tableau du projet par le même `TASK_LIST` (projet
local ou du serveur, jamais le rafraîchissement forcé) 1,5 s après, puis une seconde fois à 6 s,
quand le cache de 3 s est passé et que la dernière session a écrit son relevé. Les changements
rapprochés se regroupent. Seuls `statusHistory` et `runFacts` sont recopiés sur la carte : le
statut, l'avancement et les logs restent ceux que les événements ont donnés.

## Les personnes

`<spec>/task_people.json`, `{version: 1, createdBy?, startedBy?}`, chacun `{kind, name?, at?}`
(`kind` : `person` ou `automation`).

| Mode | Créateur | Lanceur |
|---|---|---|
| Local | noté par `createLocalTask` (`recordTaskCreator`) : l'identité git du projet (`git config user.name`, sinon le compte du système), ou une automatisation | noté à chaque lancement par `startTask` (`recordTaskLauncher`) : la même identité |
| Serveur | `specs_index.created_by` | le compte qui a lancé le dernier run de la carte, une fusion exceptée (c'est l'acte de la personne qui relit) |

En local, une carte que le fichier ne couvre pas (créée par le backend, un import, une version
d'avant) est attribuée à la personne de l'ordinateur, ou à l'automatisation qui l'a faite
(`metadata.automation`) ; son lanceur n'est donné qu'une fois la carte passée en cours.

## Le mode serveur

Le serveur ne note rien de plus. À chaque `GET /api/board/snapshot`, `shared_board/run_facts.py`
calcule pour chaque carte `task_people.json` et `usage_summary.json` (totaux de ses
`usage_records`) et les ajoute aux fichiers de la carte. Ils ne sont jamais lus dans le clone : un
fichier de ce nom qu'un agent y aurait écrit n'est pas envoyé. L'app les reçoit dans la liste
fermée de `remote-board.ts` (10 Ko chacun), les écrit dans le miroir et les revérifie à la lecture
(`readPeople`, `readUsageSummary`) ; pour un miroir, aucun repli sur l'identité locale ni sur un
relevé local.

## Données personnelles (RGPD)

- **Minimisation** : un nom d'affichage, des totaux. Aucun prompt, aucune réponse, aucun nom de
  fichier, rien sur une session prise à part.
- **Local** : le nom est celui que les commits git de la personne portent déjà, dans un dossier
  ignoré par git, et il part avec la carte.
- **Serveur** : rien n'est stocké en plus ([server-usage-data.md](../server-usage-data.md)). Le
  nom est lu à chaque instantané : renommer un compte le renomme partout, un compte supprimé
  (`SET NULL`) laisse la carte sans nom au lieu d'en garder une copie.
- **Destinataires** : quiconque lit le tableau, qui montre déjà qui tient une carte ; les vues
  d'espace de travail montrent déjà le coût des sessions.

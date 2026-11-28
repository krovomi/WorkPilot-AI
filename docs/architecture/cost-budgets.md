---
feature: Budgets de coût
summary: >-
  Budget du projet par période et plafond par tâche, lus avant chaque session d'agent quel que soit
  le fournisseur : seuils notés dans le journal, pause au plafond, modèle allégé en option,
  coupe-circuit pour une tâche qui dépense sans avancer.
---

# Budgets de coût (`cost_budget`)

Issue #355. Avant, la page Coûts affichait un budget mensuel rangé dans
`cost_data.json`, qu'aucune interface ne permettait de régler et que rien
n'appliquait : un agent qui tournait en rond dépensait jusqu'au plafond de
session (5 USD par session, `harness/application/budget.py`), session après
session, et personne ne le voyait avant d'ouvrir la page.

## Ce qui est réglé

`<projet>/.workpilot/cost-budget.json`, écrit par la page Coûts
(`renderer/components/costs/CostBudgetSection.tsx`, IPC `costs:setBudget`,
revalidé par `main/cost-budget.ts`) :

| Clé | Rôle |
|---|---|
| `limit`, `period` | budget du projet en USD pour `monthly`, `weekly` (semaine commençant le dimanche, comme la page) ou `total` |
| `task_limit` | plafond par tâche ; le `budgetUsd` d'une tâche (`task_metadata.json`) l'emporte |
| `warning_threshold`, `critical_threshold` | parts du plafond (0,75 et 0,9 par défaut) |
| `on_exceed` | `pause` (défaut) ou `warn` |
| `degrade` | passer à un modèle plus léger quand le budget s'épuise |
| `stall_multiplier` | coupe-circuit (3 par défaut, 0 = coupé) |

Un budget posé avant dans `cost_data.json` (`budgets[<chemin du projet>]`) est
encore lu tant que le nouveau fichier n'existe pas. La page n'écrit plus le
relevé lui-même : le réécrire en entier depuis le main courait contre les
agents qui y ajoutent leurs sessions sous verrou (`foundation/json_ledger.py`).

Sans aucun budget, rien ne change : ni lecture, ni pause, ni coupe-circuit.

## Où c'est lu

Avant chaque session, jamais pendant : une session commencée va au bout, rien
n'est tué au milieu d'un appel d'outil.

- boucle du coder : `agents/iteration_guards.py` (avec le détecteur de boucles,
  sorti de `agents/coder.py`) ;
- boucle QA : avant chaque passe, comme le plafond du mode objectif ;
- modèle de chaque phase : `phase_config.get_phase_model`, après le budget carbone.

La dépense vient du relevé que tous les fournisseurs remplissent
(`core/usage_tracker.py` → `cost_data.json` à la racine du projet) : le coût
rapporté par le fournisseur, sinon le prix du catalogue pour ses tokens. Une
session d'un modèle sans prix connu compte 0 à côté de vrais tokens : le total
est alors un plancher et chaque message le dit (« au moins »).

## Ce qui se passe

| Niveau | Effet |
|---|---|
| seuil d'alerte | une ligne `💰 Budget warning` dans le journal de la tâche, une fois (`budget_state.json` de la spec) ; avec `degrade`, un modèle haut de gamme passe au niveau standard du même fournisseur |
| seuil critique | une ligne `critical` ; avec `degrade`, niveau rapide |
| 100 % | avec `pause`, la tâche se met en pause par le magasin de pause commun (`foundation/pause_state.py`, raison `budget`, détail `budget`), dans la copie de la spec du build et dans celle du projet principal ; avec `warn`, rien de plus |

La dégradation reste chez le même fournisseur : ses identifiants, ses outils et
son harness sont ceux de la tâche. Le modèle visé est le plus récent du niveau
dans `models_registry` (Opus 5.5 → Sonnet 5.5, pas le plus vieux Sonnet listé),
ou le modèle de codage par défaut du fournisseur quand il est de ce niveau. Un
modèle que le registre ne connaît pas, ou local, reste tel quel.

Le coupe-circuit (raison `budget_stall`) : une fois des sous-tâches terminées,
une tâche qui dépense `stall_multiplier` fois le coût moyen d'une sous-tâche
terminée sans en terminer une nouvelle (au moins 0,50 USD) se met en pause.
Reprendre lui redonne la même marge.

## Ce que voit la personne

- La carte en pause montre « Budget atteint : 4,20 $ / 4,00 $ »
  (`task-detail/TaskBudgetPause.tsx`). Pour le plafond de la tâche, un champ
  propose 1,5 fois le plafond ; « Relever et reprendre » écrit `budgetUsd` dans
  chaque copie de la spec (IPC `costs:setTaskBudget`, tâche retrouvée par son
  id et son projet, jamais par un chemin) puis reprend. Pour le budget du
  projet, la carte renvoie à Coûts. La reprise avec un autre fournisseur reste
  possible comme pour toute pause.
- Une notification de bureau (et ntfy / Telegram) au moment de la pause
  (`main/cost-budget-notify.ts`, sous l'interrupteur « revue nécessaire ») : la
  carte ne change pas de colonne, sans elle personne ne saurait qu'elle s'est
  arrêtée.
- La page Coûts : où en est la période, la prévision, les tâches proches de
  leur plafond, et le formulaire.

## Ce qui n'est pas fait

- Le mode serveur garde son quota mensuel par organisation
  (`server/services/quotas.py`) ; un budget par projet du serveur demande une
  route et une permission à lui.
- La « réservation » du budget estimé avant de lancer une tâche : les anciens
  `budget_enforcer.py`, `live_tracker.py` et `reservation.py` de
  `cost_intelligence/` restent en mémoire de processus et ne sont branchés nulle
  part ; le budget de projet, lu avant chaque session de chaque tâche, borne déjà
  les dépassements simultanés à une session par tâche.
- Les abonnements sans facturation au token (OAuth Claude, Copilot) comptent ce
  que leur client rapporte ; aucune équivalence en sessions n'est inventée.

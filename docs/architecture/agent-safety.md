---
feature: Instantanés, sandbox et détection d'anomalies
summary: >-
  Avant chaque session d'agent, le worktree de la tâche est pris en instantané git ; pendant la
  session, un score de confiance (100 au départ) et les limites du sandbox (mode restreint,
  fichiers écrits, taille, durée) mettent la tâche en pause ou arrêtent la session et restaurent
  l'instantané ; tous providers, toutes stacks ; réglages dans Paramètres, Sandbox et Détection
  d'anomalies.
---

# Instantanés, sandbox et détection d'anomalies

> Code : `apps/backend/agent_snapshots/`, `apps/backend/agents/safety_watch.py`,
> `agents/safety_events.py`, `agents/session_guards.py`, `security/sandbox.py`,
> `security/anomaly_detector.py`, `security/agent_safety_settings.py`,
> `runners/snapshot_runner.py` ; app : `main/agent/agent-safety-env.ts`,
> `main/ipc-handlers/task/snapshot-handlers.ts`, `renderer/components/task-detail/TaskSafetyPause.tsx`,
> `renderer/components/settings/{SandboxSettings,AnomalyDetectionSettings}.tsx`.
> Règles : [`rules/security.md`](../rules/security.md) S3 et S4.

## Le problème

`security/sandbox.py` et `security/anomaly_detector.py` existaient sans être appelés : deux
routes de statut renvoyaient une instance vide, et les deux pages de réglages n'enregistraient
rien. Rien ne permettait non plus de revenir sur ce qu'une session d'agent avait fait à un
worktree, sinon à la main avec git.

## Un seul point d'accroche : la session

Toute session d'agent passe par `agents/session.py` (`run_agent_session`), sur ses deux chemins :
le SDK Claude et `_run_agent_client_session` pour tout autre `AgentClient` (Codex, Gemini,
OpenCode, pi, Copilot, Ollama…). Le disjoncteur de boucle (`tool_breaker.py`) y lisait déjà le
flux des appels d'outils. `SessionGuards` (`session_guards.py`) le remplace par deux veilleurs
sur le même flux : le disjoncteur, et `SafetyWatch`. La session s'arrête au message suivant dès
que l'un des deux a déclenché, puis `close()` restaure et écrit le rapport.

`SafetyWatch` est **au mieux** : une erreur à l'intérieur est journalisée et la session continue
avec le disjoncteur seul, comme avant. Ce n'est pas une barrière : les barrières restent les
hooks (allowlist, écritures confinées, garde-fous) et le bac à sable de l'OS, qui ne changent pas.

## Instantanés et retour arrière

Avant chaque session (planification, codage, QA), le worktree d'une tâche est enregistré comme un
commit git caché, sous `refs/workpilot/snapshots/<tâche>/<horodatage>-<phase>`
(`agent_snapshots/store.py`). Pourquoi git :

- **toutes les stacks** : `.gitignore` décide de ce qui est copié ; `node_modules`, `bin/obj`,
  `.venv`, `target` ne le sont jamais, sans liste propre à un langage ;
- **rien ne bouge** : l'instantané est construit dans une copie de l'index (`GIT_INDEX_FILE`),
  ni l'index, ni HEAD, ni la branche de la tâche ne changent ; signature GPG coupée, identité fixe ;
- `.workpilot/` est exclu (la spec, les logs, l'état de la tâche ne reviennent pas en arrière) ;
- un instantané identique au précédent (même arbre, même HEAD) n'est pas refait ; au-delà de
  `keep` (10 par défaut), les plus anciens sont supprimés.

Seul un worktree de tâche (`.workpilot/worktrees/tasks/<tâche>`) est pris ou restauré, jamais le
checkout principal du projet : `task_worktree` le reconnaît à son chemin et `worktree_of` vérifie
que git y voit bien la racine d'un worktree.

Restaurer (`rollback`) prend d'abord un instantané `before_rollback` de l'état courant (jamais
élagué par cette opération), remet la branche sur le HEAD de l'instantané, retire les fichiers
non suivis non ignorés, puis replace les fichiers de l'instantané. Un retour arrière se défait donc
en restaurant `before_rollback`.

## Le score de confiance

Chaque session démarre à 100. `safety_events.py` traduit chaque appel d'outil en événements du
détecteur, quel que soit le provider : une commande donne `command_exec`, plus `network_request`
pour une URL vers une autre machine, plus `file_delete` pour les opérandes de `rm`, `unlink`,
`git rm`, `Remove-Item`… ; une écriture donne `file_write` (et `config_change` sur un fichier de
sécurité protégé) ; une lecture `file_read`. Les impacts sont ceux de `ANOMALY_SCORE_IMPACT`
(chemin hors projet 30, suppression de masse 25, commande dangereuse, secret, réseau 20…).

Pour ne pas pénaliser un travail normal, les règles comparent des noms entiers, pas des
sous-chaînes : `rsync` n'est pas `nc`, `npm exec` n'est pas `exec`, `.env.example` n'est pas
`.env`, `curl localhost` n'est pas un accès réseau, et un même fichier sensible ne compte qu'une
fois.

Au seuil de pause (40 par défaut), la tâche est mise en pause (`pause_state.pause_task`, raison
`anomaly`) : la session s'arrête, les fichiers restent tels quels. Au seuil d'arrêt (20), la
session est arrêtée et, si l'option est active, l'instantané pris avant elle est restauré.

## Les limites du sandbox

| Limite | Défaut | Quand on la passe |
|---|---|---|
| Mode restreint : chemins inscriptibles | normal | refusé **avant** l'écriture par le hook du SDK (`path_guard`) et par `ToolExecutor` ; une CLI qui écrit avec ses propres outils est vue après coup : session arrêtée, instantané restauré |
| Taille d'un fichier | 10 Mo | refusée avant l'écriture là où WorkPilot voit le contenu ; sinon arrêt et restauration |
| Fichiers écrits par session | 200 | pause |
| Durée de la session | aucune | pause |

La spec de la tâche, `.workpilot/` et le dossier temporaire de WorkPilot restent toujours
inscriptibles. Une écriture hors du projet reste refusée en toute circonstance (S4) : le mode
restreint ne fait que resserrer.

## Les réglages

L'app garde `settings.agentSafety` (normalisé par `shared/utils/agent-safety.ts` à
l'enregistrement) et l'envoie à chaque processus d'agent dans une seule variable,
`WORKPILOT_AGENT_SAFETY` (`main/agent/agent-safety-env.ts`), relue au lancement : un changement
vaut pour la session suivante. Le backend la borne de nouveau (`security/agent_safety_settings.py`) :
un chemin absolu, avec `..` ou une lettre de lecteur est écarté. Sans la variable (CLI, mode
serveur), ce sont les valeurs par défaut. `tests/agent_safety/test_ui_parity.py` vérifie que les
impacts affichés et le format des ids d'instantané sont ceux du backend.

Les anciens modes « Docker » et « dry-run », les limites CPU et mémoire et le multiplicateur de
jetons ont été retirés de la page : rien ne les appliquait.

## Ce que voit la personne

La carte d'une tâche en pause montre une puce (`TaskSafetyPause.tsx`) : le score et les anomalies
groupées, ou la limite dépassée, et si les fichiers ont été restaurés. Elle liste les instantanés
de la tâche ; restaurer demande une confirmation. Le canal (`snapshot-handlers.ts`) refuse une
carte du serveur, un nom de tâche ou un id d'instantané mal formé, et une tâche en cours ;
`runners/snapshot_runner.py` revérifie le nom et l'id et ne travaille que dans le worktree de la
tâche. Une notification part aussi (`main/backend-pause-notify.ts`). Reprendre, c'est le bouton
Reprendre habituel.

Chaque session laisse une ligne dans `agent_safety.json` de la spec (les 20 dernières) : phase,
instantané, issue, fichiers écrits, score et anomalies.

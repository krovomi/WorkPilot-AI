# Point périodique d'une tâche longue (P1)

La durée des tâches qu'un agent réussit double environ tous les sept mois (METR, mars 2025) :
une tâche tiendra bientôt des jours, pas une session. Une personne ne suit pas une tâche de
plusieurs jours en lisant ses journaux. Elle a besoin d'un point régulier, là où elle lit déjà
les « PR prête » : Teams, Slack, Discord, Google Chat ou un webhook.

Code : `apps/backend/services/notifications/digest.py`, démarré par `handle_build_command`
(`cli/build_commands.py`) au début de chaque build.

## Ce qui part

```
⏱ Factures en PDF : en cours depuis 1 d 2 h
Sous-tâches : 2/5 terminées
En cours : Générer le gabarit
Bloquées : Signer le binaire iOS (Lancer le build iOS sur un Mac)
QA : passe 2, rejected
```

Tout est lu dans les fichiers de la tâche (`implementation_plan.json`, sa signature QA), coupé
court (titres à 120 caractères, raisons à 160, trois éléments par ligne). Ni code, ni diff, ni
ligne de journal. Quand rien n'a bougé depuis le point précédent, le point le dit : une tâche
bloquée en silence est justement ce qu'il faut voir. Un webhook générique reçoit en plus les
champs (`event: task_digest`, `subtasks_done`, `subtasks_total`, `running`, `blocked`,
`qa_iteration`, `qa_status`). Le texte suit la langue de l'application (en, fr).

## Quand

- **Désactivé par défaut.** `WORKPILOT_TASK_DIGEST_HOURS` (0,25 à 168, dans l'environnement ou
  le `.workpilot/.env` du projet) fixe l'intervalle ; sans canal configuré, rien ne part.
- Le premier point arrive un intervalle après le début du build : une tâche courte n'en envoie
  aucun.
- L'heure du début et du dernier point sont gardées dans `<spec>/memory/digest_state.json` : un
  build repris après un redémarrage attend la fin de l'intervalle en cours, il ne renvoie pas un
  point à la reprise.
- Un fil démon par build : il s'arrête avec le processus et ne le retient jamais.

## Pas couvert

- Le coût dépensé dans le point : il viendra quand le coût par tâche sera lu au même endroit
  pour tous les providers.
- La reprise après redémarrage elle-même existe déjà (`interrupted-runs.ts`, `pause_state.json`) ;
  ce lot ne la change pas.

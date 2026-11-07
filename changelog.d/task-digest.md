---
section: ✨ Nouveautés
---

- **Point périodique des tâches longues.** Avec `WORKPILOT_TASK_DIGEST_HOURS`, chaque build en
  cours envoie à intervalle régulier un point sur les canaux de notification déjà configurés
  (Teams, Slack, Discord, Google Chat, webhook) : sous-tâches terminées sur prévues, ce qui
  tourne, ce qui est bloqué et pourquoi, la passe QA, et « rien n'a bougé » quand c'est le cas.
  Le premier point arrive un intervalle après le début du build ; un build repris après un
  redémarrage ne renvoie pas de point à la reprise. Désactivé par défaut.

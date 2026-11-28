---
section: 🐛 Corrections
---

- **Une tâche qui reprend le nom d'une tâche supprimée ne reçoit plus son historique de sessions.** Une tâche supprimée cède son numéro à la suivante, et le même titre donne le même dossier (`003-test`) : le planificateur lisait les recommandations des sessions de l'ancienne tâche comme les siennes. Une session écrite avant le début de la tâche n'est plus rappelée ; la vue de toutes les sessions du projet les garde.

---
section: ✨ Nouveautés
---

- **Vagues d'exécution : liens de code et historique des exécutions** (#358, lot 3). Le score
  d'une paire de specs compte aussi les imports croisés (un fichier d'une spec importe un module
  que l'autre modifie) et les symboles supprimés ou renommés par une spec qu'un fichier de l'autre
  utilise encore, lus depuis le code et le diff du worktree, de la même façon dans tous les
  langages, avec une option pour les désactiver. Chaque exécution « dans l'ordre optimal »
  terminée ou arrêtée est consignée dans le `.workpilot/` du projet, et la vue résume les
  14 derniers jours : exécutions, conflits évités, risque retiré, specs lancées. Aucun modèle
  appelé, aucune durée estimée.

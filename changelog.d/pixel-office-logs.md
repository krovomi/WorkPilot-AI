---
section: 🐛 Corrections
---

- **Bureau Pixel : « Logs de l'agent » affiche enfin les logs.** La bulle d'une tâche lit le log de ses phases, en local comme sur un serveur, dès l'ouverture et en direct tant qu'elle reste ouverte ; une tâche terminée montre son log au lieu de rester sur « En attente de logs… », et une tâche sans aucun log le dit.
- **Les cartes ouvertes par une page (studio de tests, Import Design, pair programming…) ont un log.** Chaque exécution y écrit son résumé, ses étapes, les fichiers commités et le message du commit, visibles dans l'onglet Logs et le Bureau Pixel.
- **Le titre d'une carte du studio de tests nomme le fichier testé** (« Tests générés : order_service.py ») au lieu d'un chemin absolu coupé avant le nom du fichier quand un dossier contient une espace.
- **Bureau Pixel : plus de bouton « Arrêter » sur une tâche terminée** qui attend sa revue ; le titre complet s'affiche au survol. Fermer la bulle ne coupe plus le suivi des logs du panneau de la tâche resté ouvert.

---
section: 🧪 Filets de test
---

- **Services du backend couverts à 100 %** : bouclier de rate limit (attente trop longue, reprise
  anticipée, marqueurs impossibles à écrire), historique des tentatives d'un build (fichiers
  abîmés, plan illisible ou verrouillé), annonce d'une tâche terminée (canaux et hooks réels),
  estimation intelligente lue dans une vraie base d'historique SQLite, catalogue des providers.
  Le code jamais appelé est retiré : le classement des échecs, la décision de reprise et le
  retour arrière `git reset --hard` de la reprise, les vérifications de statut et les fonctions
  de compatibilité du catalogue des providers.

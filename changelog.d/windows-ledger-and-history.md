---
section: 🐛 Corrections
---

- **Relevés d'usage sous Windows** : quand plusieurs tâches écrivent le même relevé (coûts, tableau
  de bord, carbone), une écriture que Windows refuse un instant, parce qu'un autre programme tient
  encore le fichier, est retentée au lieu d'être perdue.
- **Historique des tests générationnels** : deux captures faites dans la même milliseconde restent
  rangées de la plus récente à la plus ancienne.
- **Mise à jour de la documentation à la release sous Windows** : le CLI Claude installé par npm est
  trouvé et lancé.

---
section: 🧪 Filets de test
---

- **Tests de l'architecture et de l'authentification indépendants de l'ordre** : le test des règles d'architecture déduites reçoit un relecteur factice et vérifie l'avertissement attendu, au lieu de compter sur l'échec de la revue IA ; les tests d'authentification défont désormais le jeton que le code écrit dans l'environnement, qui faisait démarrer le vrai CLI dans un test suivant.

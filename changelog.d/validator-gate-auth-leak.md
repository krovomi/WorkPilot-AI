---
section: 🧪 Filets de test
---

- **Tests indépendants de l'ordre et de l'OS** : le test des règles d'architecture déduites reçoit un relecteur factice et vérifie l'avertissement attendu, au lieu de compter sur l'échec de la revue IA ; les tests d'authentification défont le jeton que le code écrit dans l'environnement, qui faisait démarrer le vrai CLI dans un test suivant ; le test du spec runner ne lance plus un vrai build sous Windows ; les tests du bac à sable placent leur socket Unix dans un dossier court (limite de 104 octets sous macOS) et ne comptent plus la boucle d'acceptation du proactor Windows comme une connexion ouverte.

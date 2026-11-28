---
section: 🧪 Filets de test
---

- **Le test des chemins refusés en mode serveur ouvre sa propre base** : il reprenait le moteur de base laissé par un test précédent, lié à une autre boucle d'événements, et échouait selon l'ordre des tests (CI de main après la 1.6.0).

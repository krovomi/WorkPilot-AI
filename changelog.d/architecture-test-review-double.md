---
section: 🧪 Filets de test
---

- **Le test des règles d'architecture déduites ne lance plus de vraie revue IA** : il passait
  seul mais, après un test qui importe `core`, démarrait la CLI Claude et échouait dans la suite
  complète. La revue y est remplacée par un double, et le test vérifie qu'elle est bien demandée.

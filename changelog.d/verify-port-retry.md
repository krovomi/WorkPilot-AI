---
section: 🐛 Corrections
---

- **Vérification de l'app** : deux tâches vérifiées en même temps ne se disputent plus un port. Si l'app trouve pris le port choisi pour elle, elle est relancée sur un autre port libre, et une autre app qui répond sur ce port n'est plus prise pour la sienne.

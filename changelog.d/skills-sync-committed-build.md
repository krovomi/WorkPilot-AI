---
section: 🧹 Maintenance
---

- **La synchro hebdomadaire des skills ouvre des PR que la CI peut valider** : elle régénérait les fichiers des skills avec des packs téléchargés mais non versionnés, ce qui ajoutait une cinquantaine de skills qu'un clone propre ne reproduit pas et faisait échouer la vérification « Skills (generated output) ».

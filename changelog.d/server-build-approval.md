---
section: 🐛 Corrections
---

- **Mode serveur, revue des cartes** : après un build sur le serveur, une carte reste approuvée.
  Le build écrit sa progression dans le plan, que l'approbation couvre : elle tombait à chaque
  build, si bien qu'une relance, une reprise ou le build relancé par « Demander des changements »
  s'arrêtait sur « revue requise », et le téléphone proposait d'approuver la spec à nouveau au lieu
  de fusionner, d'ouvrir la PR ou de renvoyer le travail. Renvoyer le travail compte désormais
  comme l'approbation, par son auteur, du build qu'il relance. Les tests de bout en bout du
  téléphone suivent une carte de la spec à la revue, puis renvoyée en correction.

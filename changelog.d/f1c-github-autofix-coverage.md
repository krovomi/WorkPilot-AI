---
section: 🐛 Corrections
---

- **Approuver des lots d'auto-fix lance le runner comme les autres commandes de l'auto-fix** : avec l'environnement du runner (fournisseur choisi, jeton GitHub), sans bloquer l'app pendant l'exécution ; le dossier `.workpilot/github` est créé s'il manque, et le fichier des lots approuvés est supprimé même quand le runner échoue.
- **L'aperçu des lots dit qu'aucun résultat n'est revenu** quand le runner ne renvoie rien, au lieu du message sur un résultat illisible.

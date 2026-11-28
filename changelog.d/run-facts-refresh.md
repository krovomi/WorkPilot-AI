---
section: 🐛 Corrections
---

- **Bilan des tâches finies** : une tâche créée ou lancée puis terminée sans redémarrer l'app affichait « inconnu » partout dans son bilan (temps des agents, durée, tokens, coût, créée par, lancée par), car la carte n'était pas relue après son changement de statut. Le bilan est maintenant relu quelques secondes après chaque changement de statut, pour tous les providers, en local comme sur un projet du serveur.

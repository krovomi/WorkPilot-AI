---
section: 🐛 Corrections
---

- **Les handlers des pull requests GitHub revérifient ce que le renderer envoie avant de l'utiliser** : numéro de PR (ou liste de numéros), identifiant d'exécution de workflow, méthode de fusion (`merge`, `squash` ou `rebase`), login GitHub de l'assigné, texte d'un commentaire et curseur de page. Un appel refusé n'atteint pas le handler (`pr-ipc-guard.ts`).

---
section: 🐛 Corrections
---

- **Les handlers de l'auto-fix GitHub revérifient ce que le renderer envoie avant de l'utiliser** : numéro d'issue (ou liste de numéros), nombre maximal d'issues d'une analyse, forme de la configuration et des lots approuvés. Un appel refusé n'atteint pas le handler (`autofix-ipc-guard.ts`, sur le même garde que les pull requests, `ipc-arg-guard.ts`).
- **La configuration de l'auto-fix (`.workpilot/github/config.json`) ne garde plus de jeton** : comme le runner, l'app n'y écrit que des réglages, et retire un jeton qu'elle y trouve.

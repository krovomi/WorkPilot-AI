---
section: 🐛 Corrections
---

- **Valeurs citées dans les scripts PowerShell** : la preuve visuelle (capture de la fenêtre, pilotage UI Automation, lancement de l'application de bureau) et l'émulateur d'app (.NET Framework) citent leurs valeurs par une seule fonction, `shared/utils/powershell-quote.ts`, qui double chaque caractère que PowerShell lit comme une apostrophe, typographiques compris (‘ ’ ‚ ‛).

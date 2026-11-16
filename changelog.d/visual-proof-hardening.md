---
section: 🐛 Corrections
---

- **Scripts PowerShell** : la preuve visuelle (capture de la fenêtre, pilotage UI Automation, lancement de l'application de bureau) et l'émulateur d'app (.NET Framework) citent leurs valeurs par une seule fonction, `shared/utils/powershell-quote.ts`.
- **Preuve visuelle, navigation web** : une étape du plan de navigation reste sur l'application montrée ; une autre adresse est ignorée et journalisée, et la capture montre la page déjà atteinte.
- **Preuve visuelle, tests de bout en bout** : un vrai serveur HTTP, de vrais DOM, un vrai dépôt git avec son remote ; seuls PowerShell, `gh`, MSBuild, l'application de bureau et la capture de fenêtre sont simulés. Le lancement élevé sous Windows ne prépare plus de liste d'arguments, qu'il ne reçoit jamais.

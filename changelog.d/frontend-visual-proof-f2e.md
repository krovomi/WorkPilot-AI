---
section: 🧪 Filets de test
---

- **Couverture frontend, lot F2e (preuve visuelle, .NET Framework)** : la preuve d'un client lourd lancé par Mono ou Wine (build MSBuild contre sa solution, restauration des paquets, paquets du dépôt principal prêtés au worktree, capture de sa seule fenêtre, plan de navigation généré ou écrit) et celle d'un site ASP.NET classique hébergé par IIS Express ou xsp sont testées de bout en bout sur de vraies solutions et un vrai serveur HTTP ; seuls MSBuild, dotnet, Mono, Wine et la liste des fenêtres sont simulés. Avec les tests de bout en bout déjà là, le service de preuve visuelle passe à 98 % des instructions.
- **Test d'abstraction de plateforme** : l'exception qui autorise le log de diagnostic de `settings-handlers.ts` suit sa ligne actuelle (417), ce qui remet develop au vert.

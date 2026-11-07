---
section: ✨ Nouveautés
---

- **Migrer un projet .NET 8 ou 9, une version à la fois.** Les procédures officielles de l'équipe
  .NET pour 8 → 9 et 9 → 10 rejoignent celle de 10 → 11, revues et complétées (C# 14, EF Core 9 et
  10, NuGet en HTTP, `DefineConstants`, mutex nommés). Une tâche Kanban qui nomme .NET 9, 10 ou 11
  (ou C# 13, 14, 15) reçoit chaque étape entre la version du projet et celle demandée, dans
  l'ordre ; le planificateur prévoit une étape par version, la QA vérifie la cible. .NET 8 et 9 ne
  sont plus supportés après le 10 novembre 2026 : les procédures le rappellent et visent .NET 10
  (LTS) par défaut. Les commandes `/migrate-dotnet8-to-dotnet9` et `/migrate-dotnet9-to-dotnet10`
  apparaissent dans la palette des seuls projets concernés.

---
section: ✨ Nouveautés
---

- **Migrer vers .NET 11 et C# 15.** Une tâche Kanban qui demande de passer un projet .NET 10 à
  .NET 11 (ou à C# 15) suit désormais la procédure de migration de l'équipe .NET, revue et mise à
  jour jusqu'à la RC2 : changements cassants du compilateur, des bibliothèques, d'Extensions,
  d'ASP.NET Core, d'EF Core, du SDK, du runtime et de MAUI, avec ce qu'il faut chercher dans le code
  pour chacun. Le planificateur, le codeur et la QA la lisent, avec tous les providers ; un projet
  déjà en .NET 11 garde sous la main le guide d'adoption de C# 15 (unions, hiérarchies `closed`…).
  La commande `/migrate-dotnet10-to-dotnet11` apparaît dans la palette des seuls projets .NET 10
  ou 11. Les autres stacks ne paient rien.
- **Les projets WPF, WinUI, MAUI et à `Directory.Build.props` reçoivent les skills .NET** (F158) :
  la version cible `net10.0-windows`, `net11.0-android`… et celle d'un `Directory.Build.props` sont
  maintenant lues, et `netstandard2.0` n'est plus pris pour « .NET 2.0 ».

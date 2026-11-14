---
section: 🐛 Corrections
---

- **Le détective de tests instables lance vraiment les tests .NET, et ceux de toutes les stacks** (F204). Sur une solution qui ne liste aucun projet de test, `dotnet test` compilait sans rien lancer et le détective accusait une erreur de compilation : il vise désormais les projets de test (la solution qui les contient, sinon les projets eux-mêmes), gère Microsoft.Testing.Platform de .NET 10 (xunit.v3, MSTest) et dit clairement « aucun projet de test » ou « aucun test lancé », avec la fin de la sortie et le chemin du journal complet. Jest sans plugin, `node --test`, Rust, PHPUnit/Pest, RSpec, Dart/Flutter et Swift sont pris en charge ; la porte de mutation ne lance plus `dotnet test` sur une solution sans tests.

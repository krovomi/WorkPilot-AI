---
section: ✨ Nouveautés
---

- **Dérive d'architecture pour toutes les stacks** : les imports sont lus en C#, F#, VB (et
  références de projets `.csproj`), Java, Kotlin, Scala, Go, PHP, Rust, Dart/Flutter et Swift,
  en plus de Python et TypeScript. Sans fichier de règles, les couches Domaine, Application,
  Infrastructure et Présentation sont déduites des projets .NET (`Shop.Domain`, `Shop.Api`…),
  des modules Maven/Gradle, des paquets Kotlin, de `go.mod`, de `composer.json`, de
  `Cargo.toml`, de `pubspec.yaml` et des cibles Swift ; la règle de dépendance et
  l'interdiction des frameworks de persistance ou web dans le domaine sont vérifiées, et
  chaque violation est formulée dans la langue de l'app.

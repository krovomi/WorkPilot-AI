---
section: 🐛 Corrections
---

- **Gouvernance des licences : des licences enfin résolues, pour toutes les stacks**. Le scan
  ne lisait la licence que dans le manifeste, où elle n'est jamais : chaque dépendance sortait
  « inconnue » et le scan échouait toujours. Il la lit maintenant dans le fichier de
  verrouillage, puis dans le paquet installé (node_modules, venv, cache NuGet, Cargo, Go, Maven,
  pub), puis dans les registres publics (deps.dev, npm, PyPI, Packagist, RubyGems, pub.dev),
  jamais sous une politique hors-ligne stricte. Il lit aussi les projets .NET (`*.csproj`,
  `Directory.Packages.props`, `packages.config`), Java/Kotlin (`pom.xml`, `build.gradle(.kts)`),
  PHP (`composer.lock`), Ruby (`Gemfile.lock`) et Dart/Flutter (`pubspec.lock`). Une licence
  introuvable est rangée « à vérifier », à part des vrais conflits.

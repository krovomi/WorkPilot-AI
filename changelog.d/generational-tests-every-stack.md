---
section: 🐛 Corrections
---

- **Tests générationnels, pour toutes les piles** : une génération ne se créait qu'à partir d'un
  JUnit XML collé à la main, donc rien pour un projet .NET (TRX), Go, Rust, Jest ou Vitest sans
  reporter JUnit, Dart/Flutter ou RSpec. Le panneau lance maintenant la suite du projet lui-même
  (la commande détectée par le Détective de tests instables : dotnet test, pytest, Vitest, Jest,
  Maven, Gradle, go test, cargo test, PHPUnit/Pest, RSpec, dart/flutter test, swift test), ou
  importe un fichier de rapport, ou le lit collé ; le format (JUnit XML, TRX, JSON de Jest/Vitest,
  go test -json, sortie de cargo test, JSON de Dart, JSON de RSpec) est reconnu au contenu. La
  référence se choisit dans la liste, chaque génération montre sa date, sa source et ses
  compteurs, et les erreurs (pas de projet de test .NET, build en échec avec la fin de sa sortie,
  format inconnu) sont traduites. Le hook pre-commit `gen-tests-check` lit aussi le TRX.

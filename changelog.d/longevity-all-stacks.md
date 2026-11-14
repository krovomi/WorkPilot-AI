---
section: 🐛 Corrections
---

- **Longévité et dette technique sur toutes les stacks** : le scanner ne lisait que neuf
  extensions et seuls le `package.json` et le `requirements.txt` de la racine. Il lit maintenant
  Kotlin, Swift, Dart, PHP, Ruby, C/C++, F#, VB, Vue, Svelte, Razor et Elixir, compte les
  fonctions Go, Kotlin et Swift, et relève les dépendances instables ou non épinglées de chaque
  manifeste du dépôt (monorepos compris) : NuGet (`*`, préversions), Maven (`-SNAPSHOT`, plages),
  Gradle (`+`, `latest.release`), Cargo (`*`, git sans `rev`), Go (pseudo-versions), Composer
  (`*`, `dev-`), pub (`any`, git), npm et pip. Le score de longévité et l'analyse de dette
  technique du mode serveur en profitent.

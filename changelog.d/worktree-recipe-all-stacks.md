---
section: 🐛 Corrections
---

- **La préparation du worktree trouve chaque projet d'un monorepo.** Sans `.workpilot/worktree.toml`,
  WorkPilot lit maintenant la racine et les dossiers jusqu'à trois niveaux : un front dans
  `apps/web` et une API dans `src/Api` reçoivent chacun leur commande, lancée depuis la racine avec
  l'option de leur outil (`npm --prefix`, `pnpm --dir`, `dotnet restore src/App.sln`…). Les membres
  d'un workspace n'ont pas de commande à eux. Une solution .NET rangée dans un sous-dossier est
  nommée, au lieu d'un `dotnet restore` qui s'arrêtait faute de projet à la racine. Nouvelles
  stacks détectées : Gradle sans wrapper, sbt, Elixir, Swift, Deno, vcpkg, Conan, F# et VB.NET.

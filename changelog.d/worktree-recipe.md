---
section: ✨ Nouveautés
---

- **Préparation des worktrees, pour toutes les stacks.** Chaque nouveau worktree de tâche est
  préparé avant la première session : `npm ci` ou pnpm/yarn/bun, `dotnet restore`, `uv sync`,
  poetry ou pip, `go mod download`, `cargo fetch`, composer, bundler, `flutter pub get`, Gradle ou
  Maven, d'après les fichiers du projet. `.workpilot/worktree.toml` permet d'écrire sa propre
  recette (commandes en liste d'arguments, sans shell ; fichiers ignorés à copier comme
  `.env.local` ; un bloc de ports propre à chaque tâche ; un nettoyage à la suppression). Une
  recette écrite ne tourne qu'une fois approuvée telle quelle, dans Réglages du projet → Général.
  Une étape en échec n'arrête pas la tâche : l'agent la lit dans son prompt. Les agents ne peuvent
  pas modifier la recette.

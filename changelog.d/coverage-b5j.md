---
section: 🧪 Filets de test
---

- **Couverture backend, lot B5 (Incident Responder)** : `self_healing/incident_responder/` est entièrement couvert : analyse de fragilité, mode CI/CD, mode production, mode proactif, orchestrateur et sauvegarde de l'état. Le plancher de couverture du backend passe de 89 à 92 %.
  - Code mort retiré, preuves à l'appui : la recherche du fichier de test d'un fichier source, la lecture d'un événement Sentry, la normalisation de la gravité, le détail d'un incident et le relevé d'une seule source, que rien n'appelait.
- 🐛 **Le mode CI/CD lance les tests avec la commande de la pile du projet** (.NET, pytest, Vitest, Jest, Maven, Gradle, Go, Rust, PHP, RSpec, Dart, Swift), sans shell et sans les identifiants du backend. Avant, seuls Python, Node, Go et Rust étaient reconnus, et le chemin de pytest ne valait pas sous Windows.
- 🐛 **Le premier commit d'un historique a son diff** dans l'incident CI/CD, et une valeur qui ne désigne aucun commit n'est plus passée à git.
- 🐛 **La couverture Istanbul `coverage-final.json` est lue** (Jest, Vitest, nyc, c8) : un fichier couvert n'y comptait plus comme découvert.
- 🐛 **Le churn d'un projet logé dans un sous-dossier d'un dépôt** compte ses propres commits, et les dossiers `*.egg-info` ne sont plus analysés.
- 🐛 **Un nouveau scan proactif ne double plus les incidents** : un fichier qui a déjà un incident ouvert le garde, avec les mesures du dernier scan. La description cite la vraie période de churn.
- 🐛 **Un incident qu'une version ne sait pas relire n'efface plus les autres** au démarrage, et une opération terminée ne peut plus être annulée.
- 🐛 **Un incident de production relevé garde la source qui l'a signalé**, au lieu d'être attribué à Sentry ou deviné d'après le nom du service.

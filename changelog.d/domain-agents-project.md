---
section: 🐛 Corrections
---

- **Agents spécialisés par domaine appliqués au projet** : le domaine choisi s'enregistre dans
  `.workpilot/domain.json` du projet (« Appliquer à ce projet »), et chaque tâche Kanban en reçoit
  les garde-fous à la planification, au code et à la QA, y compris dans son worktree. Avant, le
  panneau ne faisait qu'un aperçu : seul un `domain` écrit à la main dans `requirements.json`
  atteignait les agents. Les bibliothèques conseillées suivent les stacks détectées du projet
  (.NET, Java/Kotlin, Go, Rust, PHP, Ruby, Dart, Swift, Python, JS/TS…), et non plus Python et
  npm seuls.

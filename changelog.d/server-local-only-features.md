---
section: 🐛 Corrections
---

- **Un serveur ne sert que les features des projets d'une organisation.** En mode serveur, le tableau, les features partagées et l'espace de travail d'un projet restent servis par son `project_id` ; les outils de la machine écrits pour l'app de bureau (hooks, coûts et budgets, santé des agents, replay, réglages des fournisseurs…) ne sont plus montés et répondent 404, et le planificateur des hooks n'y démarre pas. Ils restent entiers dans le backend local de l'app. Une nouvelle feature déclare où elle est servie (`SERVER_FEATURES` ou `LOCAL_ONLY_FEATURES`), et une feature d'aucune liste n'est pas montée sur un serveur.

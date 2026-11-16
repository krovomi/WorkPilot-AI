---
section: 🐛 Corrections
---

- **Les revues de PR restent dans le projet et suivent les instructions de l'app** : les
  relecteurs GitHub, GitLab et Azure DevOps lisent le dossier du projet relu, même quand il
  s'appelle `backend` ; la revue Azure DevOps prend ses instructions dans l'app et non dans le
  dépôt relu ; le titre, la description, le diff, les branches, l'auteur et les fichiers d'une
  MR GitLab ou d'une PR Azure DevOps sont cités par l'assistant commun, comme sur GitHub ; les
  relecteurs et le tri des issues travaillent sur le contenu du dépôt, sans recherche web.

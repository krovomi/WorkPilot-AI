---
section: 🐛 Corrections
---

- **Les revues de PR restent dans le projet et suivent les instructions de l'app** : les
  relecteurs GitHub, GitLab et Azure DevOps lisent le dossier du projet relu, même quand il
  s'appelle `backend` ; la revue Azure DevOps prend ses instructions dans l'app et non dans le
  dépôt relu ; le titre, la description, le diff, les branches, l'auteur et les fichiers d'une
  MR GitLab ou d'une PR Azure DevOps sont cités par l'assistant commun, comme sur GitHub ; les
  relecteurs et le tri des issues travaillent sur le contenu du dépôt, sans recherche web.
- **Tri et regroupement des issues GitHub** : le titre, le corps, l'auteur et les étiquettes
  d'une issue sont cités par l'assistant commun ; le relecteur de suivi et le tri tournent en
  lecture seule ; l'auteur d'une étiquette se retrouve même sur une issue très active ; une
  référence de PR commence toujours par une lettre ou un chiffre. Le texte cité perd les
  caractères qu'un lecteur ne voit pas (contrôle, largeur nulle, étiquettes Unicode).

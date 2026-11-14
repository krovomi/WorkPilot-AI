---
section: 🧪 Filets de test
---

- **Couverture backend, lot B1g (runners)** : Design-to-Code, la dictée locale, l'Idéation, le Coach personnel et son profil de style, l'accessibilité, la documentation, le studio de génération de tests, le changelog et la roadmap passent à 100 %, lancés comme l'application les lance, dans l'environnement UTF-8 qu'elle leur donne. Seuls les appels au modèle sont remplacés ; l'export Figma passe par son client HTTP. Un chemin de fichier proposé par le modèle hors du dossier de sortie reste refusé.
- **Idéation** : une génération dont aucun type n'a produit d'idée est désormais un échec. Elle se terminait en succès, et la page affichait une idéation « terminée » vide.
- **Coach personnel et accessibilité** : un message d'erreur s'affiche sans les guillemets qui l'entouraient, et un enregistrement d'exécution illisible (`"tokensUsed": "beaucoup"`) est ignoré au lieu de faire échouer tout le coaching.
- **Génération de tests, projets Python** : les bibliothèques déclarées dans un `pyproject.toml` (PEP 621, groupes PEP 735, Poetry) ou un `Pipfile` sont reconnues. Le fichier était lu ligne par ligne : `"pytest>=8",` dans une liste n'était jamais vu, et le studio proposait d'ajouter pytest à un projet qui l'avait déjà.
- **Roadmap** : la génération reprend l'index du projet lui-même (`.workpilot/project_index.json`), comme la spécification et l'Idéation. Elle le cherchait à côté des runners du backend, où un index d'un autre projet aurait été copié dans chaque roadmap ; le fichier de ce genre resté dans le dépôt, qui décrivait un projet sans rapport, est supprimé.

---
section: ✨ Nouveautés
---

- **La veille des contrats d'API compare la branche avec sa cible** (F191). OpenAPI, GraphQL et protobuf sont comparés contrat par contrat à la base de fusion, sans modèle : ce qui supprime ou resserre est cassant, ce qui élargit ou déprécie peut l'être, ce qui ajoute ne l'est pas. Chaque changement liste ses consommateurs, ceux du registre `.workpilot/api-consumers.yaml` et le code du dépôt qui cite l'endpoint, dans toutes les piles. Une rupture voulue se déclare avec `x-breaking-acknowledged`. La porte QA `WORKPILOT_QA_API_CONTRACT` (`warn` par défaut, `strict` pour bloquer), une section « API contract changes » dans la PR, le bouton « Comparer avec une branche » de la page API Watcher, `python -m api_watcher check` et un workflow CI épinglé à copier (#389).

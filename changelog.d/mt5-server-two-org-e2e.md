---
section: 🐛 Corrections
---

- **Le flux en direct d'un serveur marche à nouveau** : avec websockets 17, le serveur de streaming ne lisait plus le canal demandé ni le jeton de l'API et des runs ; connecté à un serveur, on était refusé sur le tableau de son propre projet et aucun événement n'arrivait. Les routes `/projects/{id}/…` répondent aussi 404, et non plus 403, au projet d'une autre organisation.

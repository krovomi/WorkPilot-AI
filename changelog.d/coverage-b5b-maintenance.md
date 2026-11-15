---
section: 🧹 Maintenance
---

- **Code mort retiré, lot B5b** : dans Mission Control, les nœuds de décision et méthodes que rien n'appelait ; dans le Streaming, les émetteurs du gestionnaire que seuls les agents utilisent par leur wrapper, l'enregistreur inutilisé du serveur, la suppression et les statistiques d'enregistrement, et la prise en charge d'anciennes versions de `websockets` (la version requise est 17.4).

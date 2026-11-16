---
section: 🧪 Filets de test
---

- **Composants du frontend, troisième lot** : la vue des outils des agents (serveurs MCP du projet et de chaque agent) et la fenêtre d'un serveur MCP personnalisé sont rendues et utilisées par leurs tests.
- **Outils des agents** : la liste des serveurs d'un agent suit celle du build (Electron, Puppeteer et Chrome DevTools seulement quand le projet les active, Linear seulement avec l'intégration Linear) ; les noms et descriptions des serveurs, le vérificateur et son serveur s'affichent en français ; un enregistrement refusé remet l'ancienne valeur ; une vérification d'état refusée ne tourne plus sans fin ; les interrupteurs et les icônes d'état sont nommés pour un lecteur d'écran.
- **Changement de projet** : un enregistrement qui échoue après être passé à un autre projet ne vide plus la configuration de celui-ci.
- **Serveur MCP personnalisé** : vider le jeton d'un serveur le retire ; un nom sans lettre ni chiffre, ou l'identifiant d'un serveur intégré (`github`…), est refusé ; la valeur d'un en-tête n'est plus réaffichée en clair.

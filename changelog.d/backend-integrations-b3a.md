---
section: 🧪 Filets de test
---

- **Couverture backend, lot B3a (intégrations)** : tout le dossier `integrations/` passe à 100 %. Le client Windsurf (découverte des identifiants, appel de chat en streaming, flux Cascade) est testé contre un faux serveur de langage local qui parle le vrai protocole Connect ; la mise à jour Linear passe par le port `agent_runtime` avec un client de remplacement ; JEV et les notifications Slack / Teams envoient de vraies requêtes à un serveur local.
- **Notifications Slack / Teams** : une adresse de webhook qui n'est pas une URL (`pas une url`) est refusée comme un schéma interdit. L'envoi levait une exception, alors qu'il ne doit jamais faire échouer l'appelant.
- **Windsurf, mode Cascade** : le message d'erreur renvoyé par le serveur s'affiche sans les espaces qui suivaient sa première ligne.
- **Code mort retiré** : `integrations/windsurf_mcp.py` (une intégration MCP jamais connectée : le test de connexion Windsurf passait toujours par l'API directe), le paquet `integrations/azure_devops/` (aucun appelant ; Azure DevOps passe par `src/connectors/azure_devops`) et le gestionnaire de projet Linear (`LinearManager`, aucun fichier ne créait l'état qu'il lisait). La vérification de l'environnement d'un build n'annonce plus un projet Linear « initialisé pendant la planification » qui ne l'était jamais.

---
section: ✨ Nouveautés
---

- **Alertes sur les serveurs MCP installés** : une fois par jour, l'app relit le registre et les
  vulnérabilités connues des serveurs du catalogue installés dans vos projets, et la liste des
  serveurs installés signale ce qui a empiré depuis la dernière lecture : nouvel avis de
  vulnérabilité pour la version lancée, nouveau mainteneur, paquet déprécié ou retiré, score
  tombé sous 50. Chaque alerte s'acquitte. Un serveur ajouté à la main est marqué « non
  vérifiable » et n'est jamais lu sur le réseau ; rien n'est lu pour un projet en hors-ligne strict.
- **Liste blanche MCP d'entreprise** : un fichier `.workpilot/mcp-policy.json` facultatif limite
  ce qui peut être installé dans le projet (serveurs du catalogue autorisés, score de sécurité
  minimum, serveurs hors catalogue interdits). Elle s'applique à l'enregistrement des réglages du
  projet ; une installation refusée dit pourquoi, et un fichier invalide bloque toute installation
  en le signalant.

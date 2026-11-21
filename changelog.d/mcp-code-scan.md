---
section: ✨ Nouveautés
---

- **Analyse du code des serveurs MCP** : en ouvrant les détails d'un serveur du catalogue, l'app
  lit l'archive publiée par npm ou PyPI pour la version lancée (vérifiée par son empreinte, lue en
  mémoire, jamais exécutée) et y cherche ce qui lance des programmes, exécute du code construit à
  la volée, contient une chaîne en forme d'identifiant, écrit des fichiers ou ouvre le réseau. Le
  score gagne une dimension « Code source », qui compare aussi ce que le code fait avec ce que
  ses outils déclarent ; un code introuvable ou illisible ne peut pas être audité et le dit. La
  revérification quotidienne alerte quand une nouvelle version apporte un de ces motifs.
- **Constats acceptés** : `.workpilot/mcp-policy.json` accepte `acceptedFindings`, un constat
  examiné par l'équipe avec sa raison, qui ne coûte plus de points et s'affiche avec elle.
- **Outils des agents** : un serveur MCP refusé par la politique du projet dit désormais pourquoi.

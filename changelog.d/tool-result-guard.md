---
section: 🔒 Sécurité
---

- **Chaque résultat d'outil est analysé avant que l'agent ne le lise** (F190). Fichier lu, page récupérée, sortie de commande, réponse MCP : sur les providers de la boucle WorkPilot et sur Claude, un résultat suspect arrive encadré derrière un avertissement, et avec `WORKPILOT_TOOL_RESULT_GUARD=block` un résultat bloqué est retenu. Les motifs reconnaissent désormais l'espagnol, l'allemand, l'italien, le portugais, le chinois et le japonais. La page Injection Guard liste ce qui a été signalé dans chaque tâche (la source seule, jamais le contenu) et les sources de confiance à exempter, comme des fixtures de test ; les agents ne peuvent pas modifier cette liste (#388).

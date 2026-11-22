---
section: ✨ Nouveautés
---

- **Serveurs MCP confinés** (#369) : un serveur MCP personnalisé peut tourner confiné, dans le bac à sable de l'OS, avec seulement les hôtes qu'il liste sur le réseau (plus le registre d'où il s'installe) et des écritures limitées au projet. Une case « Exécuter confiné » le règle dans la fenêtre du serveur ; une politique de projet (`confineBelow` dans `.workpilot/mcp-policy.json`) confine d'office les serveurs dont le score de sécurité est sous le seuil et ceux hors catalogue. Le confinement vaut pour tous les fournisseurs (SDK Claude, Codex, OpenCode, agents ACP, modèles OpenAI, Google, compatibles et locaux) ; là où le bac à sable manque (Windows, bubblewrap absent), un serveur confiné ne démarre pas.

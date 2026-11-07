---
section: 🔒 Sécurité
---

- **Épinglage des outils MCP.** La description d'un outil MCP est lue par le modèle et jamais
  montrée : un serveur peut y cacher des instructions, ou changer ses outils après coup. Les
  outils de chaque serveur MCP personnalisé sont maintenant épinglés par l'empreinte de ce que lit
  le modèle. Un outil ajouté ou une description modifiée est retenu tant que vous ne l'avez pas
  approuvé, dans Outils des agents → serveurs MCP, avec l'ancienne description à côté de la
  nouvelle. Une description qui ressemble à une instruction cachée demande une confirmation
  explicite. Les serveurs déjà configurés sont épinglés au premier contact. Les agents ne peuvent
  pas écrire `.workpilot/mcp-pins.json`.
- **Serveurs MCP HTTP.** Avec le SDK MCP 2, le pont WorkPilot ne parvenait à joindre aucun serveur
  personnalisé en HTTP (`streamablehttp_client` a été renommé) ; il utilise maintenant le nouveau
  transport.

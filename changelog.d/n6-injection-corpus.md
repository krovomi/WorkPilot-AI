---
section: 🔒 Sécurité
---

- **Le garde d'injection est mesuré sur 51 charges connues** (F128). Une issue, une PR ou un
  commentaire de revue qui s'adresse à l'agent, lui demande un secret, un push sans revue ou un
  script distant, ou cache sa consigne (lettres espacées, caractères d'aspect latin, octets
  échappés) est désormais signalé dans le journal de la spec ; le jeu de charges tourne en CI.

---
section: 🐛 Corrections
---

- **Les images partent enfin vers une carte du serveur.** En mode serveur, les images jointes à une nouvelle tâche étaient perdues sans un mot, et celles d'une demande de changements refusées (« pas encore »). Elles partent maintenant avec la requête, le serveur vérifie leurs octets (PNG, JPEG, GIF ou WebP, au plus 10 de 5 Mo ; pas de SVG) et les range là où les agents les lisent, comme l'app le fait en local : `attachments/` de la carte, `feedback_images/` de l'espace de build. Une image que le serveur n'accepterait pas est refusée dans l'app, jamais perdue.

---
section: ✨ Nouveautés
---

- **Héberger le serveur multi-utilisateur là où l'équipe le peut** : `deploy/configure.py`
  demande où tourne le serveur (un VPS ou un serveur avec un nom DNS public en HTTPS, une
  machine du réseau local, ou cet ordinateur pour un essai) et écrit `.env.server` (secrets
  générés une seule fois, gardés quand on change de choix), le `Caddyfile` et le proxy qui
  rendent l'API et le flux en direct joignables. Le guide d'exploitation décrit les trois cas,
  un PC Windows sous Docker Desktop compris.

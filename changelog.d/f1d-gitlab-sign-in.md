---
section: 🐛 Corrections
---

- **Connexion GitLab par `glab` sur une instance auto-hébergée** : la page des réglages envoie
  le nom d'hôte de l'instance, que le main lisait comme une URL invalide avant de retomber sur
  gitlab.com. La vérification de la connexion, la connexion, l'utilisateur et la liste des
  projets visent maintenant l'instance configurée (port compris). Le jeton de `glab` s'affiche
  comme défini, comme les autres jetons du projet, et c'est le main qui l'enregistre quand on
  valide la connexion. `glab` est lancé par son chemin, sans shell, et la page de connexion
  s'ouvre par `openExternalUrl`, sur l'hôte de l'instance seulement. Un projet GitLab réglé par
  son URL de clone fonctionne, et un en-tête `X-Total` illisible compte zéro. Cinq canaux IPC
  que l'interface n'appelait jamais (détection du projet, branches, création de projet, ajout
  du remote, groupes) et deux fonctions inutilisées sont retirés ; la connexion et les
  utilitaires GitLab sont couverts à 100 %.

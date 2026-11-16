---
section: 🛠️ Qualité
---

- **Connexion GitHub par `gh` et création de dépôt alignées sur les autres réglages** : le jeton
  de `gh` s'affiche comme défini, comme les autres jetons du projet, et c'est le main qui
  l'enregistre quand on valide la connexion. Le nom, le propriétaire, la visibilité et la
  description d'un nouveau dépôt sont vérifiés avant toute commande ; `gh` et `git` sont lancés
  par leur chemin, sans shell, et la page de connexion s'ouvre par `openExternalUrl`. Un appel
  inutile à `git branch --show-current` et deux fichiers de test vides sont retirés ; les
  handlers de connexion sont couverts à 100 %.

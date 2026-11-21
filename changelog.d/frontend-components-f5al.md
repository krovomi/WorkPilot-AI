---
section: 🐛 Corrections
---

- **Profil d'agent** : les profils prédéfinis (Tâches complexes, Équilibré, Modifications rapides…), leurs descriptions et les niveaux de réflexion s'affichent dans la langue de l'app ; la liste des profils écrit « Élevé » ou « Ultra Think » au lieu de la valeur brute (`high`), et chaque liste de modèle ou de réflexion d'une phase porte le nom de sa phase pour un lecteur d'écran.
- **Badge d'authentification** : un fournisseur sans nom connu (LM Studio, fournisseur personnalisé) garde son nom au lieu d'un badge vide, un profil d'adresse inconnue dit « Inconnu » en français, et l'état de GitHub CLI ou du compte Windsurf ne s'affiche plus pour un fournisseur quitté entre-temps.
- **Badges des CLI** : un échec de mise à jour de Codex CLI s'affiche en français ; la seconde vérification qui suit une mise à jour n'a plus lieu une fois le badge fermé ; un agent CLI installé sans vérification jointe est revérifié et passe à « Installé ».
- **Remote Azure DevOps** : le bouton de fermeture ferme la fenêtre, une adresse refusée le dit dès la saisie, et les champs de l'adresse et du jeton sont nommés pour un lecteur d'écran.

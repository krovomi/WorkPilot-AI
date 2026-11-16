---
section: 🐛 Corrections
---

- **Réglages du projet** : désactiver Linear, GitHub, GitLab ou Azure DevOps efface le dernier
  état de connexion au lieu de le laisser affiché ; la connexion GitHub par la CLI abandonne
  bien au bout de cinq minutes sans réponse (le délai était annulé dès l'affichage suivant) et
  transmet le compte déjà connecté ; la connexion Claude ne rappelle plus l'écran suivant une
  fois la fenêtre fermée ; un changement de dossier, un terminal qui ne s'ouvre pas ou une
  branche principale introuvable le disent au lieu de ne rien faire ; la recette du worktree
  dit quand elle n'a pu être ni lue ni enregistrée ; les messages d'erreur de ces écrans sont
  traduits, les boutons « Copier » et l'affichage d'un secret sont nommés pour un lecteur
  d'écran, et les interrupteurs des réglages généraux sont reliés à leur libellé.

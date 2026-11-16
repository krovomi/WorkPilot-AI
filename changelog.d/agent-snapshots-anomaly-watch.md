---
section: ✨ Nouveautés
---

- **Instantanés et retour arrière** : avant chaque session d'agent (planification, codage, QA),
  le worktree de la tâche est enregistré comme un commit git caché, pour toutes les stacks
  (`.gitignore` décide de ce qui est copié). La carte d'une tâche en pause liste ses instantanés
  et en restaure un après confirmation ; l'état remplacé est gardé comme instantané lui aussi.
- **Score de confiance** : chaque session démarre à 100 et chaque anomalie (chemin hors projet,
  suppression de masse, commande dangereuse, secret lu, accès réseau, configuration de sécurité
  modifiée…) le fait baisser, sur tous les providers. Sous le seuil de pause, la tâche se met en
  pause ; sous le seuil d'arrêt, la session est arrêtée et son instantané restauré. La carte
  affiche le score et ce qui l'a fait baisser.
- **Sandbox** : mode restreint (seuls les chemins listés sont inscriptibles), nombre de fichiers
  écrits, taille d'un fichier et durée de session par session. Paramètres, Sandbox et Détection
  d'anomalies enregistrent enfin leurs réglages, que le backend applique.

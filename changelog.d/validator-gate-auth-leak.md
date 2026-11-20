---
section: 🧪 Filets de test
---

- **Tests d'authentification indépendants de l'ordre** : ils défont le jeton que le code écrit dans l'environnement, qui faisait démarrer le vrai CLI dans un test suivant.
- **Retour arrière d'un instantané de tâche** : la restauration écrit chaque fichier de l'instantané depuis un index vide, sans se fier au cache de l'index du worktree, qui pouvait laisser un fichier dans son état d'avant le retour arrière (vu sous Windows avec Git 2.56.1).
- **Worktree à la racine d'un lecteur Windows** : la détection d'isolement du worktree renvoie la racine du lecteur (`D:\`) comme projet parent, et non `D:`, qui désigne le dossier courant de ce lecteur.

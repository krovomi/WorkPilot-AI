---
section: 🧪 Filets de test
---

- **Tests indépendants de l'ordre et de l'OS** : le test des règles d'architecture déduites reçoit un relecteur factice et vérifie l'avertissement attendu, au lieu de compter sur l'échec de la revue IA ; les tests d'authentification défont le jeton que le code écrit dans l'environnement, qui faisait démarrer le vrai CLI dans un test suivant ; le test du spec runner ne lance plus un vrai build sous Windows ; les tests du bac à sable placent leur socket Unix dans un dossier court (limite de 104 octets sous macOS) et ne comptent plus la boucle d'acceptation du proactor Windows comme une connexion ouverte ; le test des worktrees du terminal résout son dossier temporaire en forme longue sous Windows (RUNNER~1).
- **Retour arrière d'un instantané de tâche** : la restauration écrit chaque fichier de l'instantané depuis un index vide, sans se fier au cache de l'index du worktree, qui pouvait laisser un fichier dans son état d'avant le retour arrière (vu sous Windows avec Git 2.56.1).
- **Worktree à la racine d'un lecteur Windows** : la détection d'isolement du worktree renvoie la racine du lecteur (`D:\`) comme projet parent, et non `D:`, qui désigne le dossier courant de ce lecteur.

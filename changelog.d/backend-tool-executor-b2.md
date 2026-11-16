---
section: 🧪 Filets de test
---

- **Couverture backend, lot B2e** : l'exécuteur d'outils, par lequel passent les lectures, écritures, recherches et commandes de tous les providers autres que le SDK Claude, passe à 100 %. Chaque outil est appelé sur un vrai projet comme le fait un client (chemin hors du projet, fichier binaire, dossier à la place d'un fichier, fichier lié hors du projet, plan vide), les commandes sont de vrais processus (sortie sur les deux flux, code 1 sans sortie, arrêt de l'arbre de processus, `taskkill` sous Windows), et le bac à sable de l'OS est remplacé par un double qui lance la commande et nomme les hôtes refusés.
- **Exécuteur d'outils** : l'OS se lit par `foundation.platform` et non plus par `os.name`, les erreurs de lecture et d'écriture attrapées sont celles du disque, et huit gardes autour de modules du backend qui ne peuvent pas échouer à l'import sont retirées.

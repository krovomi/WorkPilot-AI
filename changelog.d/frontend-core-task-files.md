---
section: 🐛 Corrections
---

- **Fichiers modifiés d'une tâche** : un fichier qui n'a pas pu être lu n'ouvre plus un éditeur
  vide, dont l'enregistrement écrasait le fichier par un texte vide ; Enregistrer attend que le
  fichier soit lu. Abandonner des fichiers (retour à la branche de base, nouveaux fichiers
  supprimés) demande un second clic, garde sélectionnés ceux qui n'ont pas pu l'être, et ses
  messages sont traduits. Un enregistrement ou un ajout de fichier raté le dit au lieu de
  seulement l'écrire dans les journaux.
- **Fichiers d'une sous-tâche** : l'éditeur ne prétend plus modifier le contenu des fichiers ; il
  retire du plan les fichiers que la sous-tâche doit laisser, et le dit. La visionneuse compte
  les lignes de la sous-tâche seule (et non de toute la branche) et garde la liste des fichiers
  prévus quand le worktree ne donne pas de diff.
- **Carte de tâche** : catégorie, priorité, complexité, impact, gravité et type d'idée sont
  traduits ; une synchronisation des critères d'acceptation ou une note qui échoue le dit. Les
  prérequis proposés montrent leur colonne. Ces écrans sont testés par leur comportement.

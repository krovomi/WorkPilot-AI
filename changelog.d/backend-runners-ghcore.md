---
section: 🐛 Corrections
---

- **Le tri des issues GitHub lit enfin la réponse du modèle** : la réponse était toujours lue vide, et chaque issue repartait classée « fonctionnalité » à 50 % de confiance, quoi que le modèle ait dit.
- **Le détail d'une PR GitHub (`/api/github/pr-details`) répond** : la route échouait à chaque appel. Elle accepte une URL `https://github.com/<propriétaire>/<dépôt>/pull/<numéro>` et refuse toute autre forme avant d'appeler `gh`.
- **Le provider GitHub sait fusionner et fermer une PR, créer et fermer une issue, créer et lister des labels, et poster sur l'API** : ces opérations appelaient une méthode absente et échouaient toujours.
- **Deux exécutions ne tiennent plus le même verrou d'état en même temps** : en le relâchant, le fichier de verrou était supprimé pendant qu'une autre exécution l'attendait, et une troisième pouvait verrouiller un nouveau fichier à côté. Le fichier reste désormais en place (il n'est supprimé que sous Windows, qui refuse de supprimer un fichier encore ouvert ailleurs).
- **Une relance d'auto-fix refusée ou en échec ne remplace plus le résultat précédent** : l'issue garde l'état terminé ou échoué de sa dernière exécution.
- **La limite de débit GitHub s'applique aussi aux fonctions non asynchrones**, qui levaient une erreur au lieu de s'exécuter.
- **Le nettoyage des PR suivies compte chaque PR une fois**, même quand elle est à la fois expirée et bloquée « en cours ».
- **Couverture backend, lot GitHub (cœur du runner)** : le provider GitHub, la route de détail de PR, les modèles, le validateur de lots, le tri, l'auto-fix, les prompts, les worktrees de revue, les permissions, la détection de bots, le runner, le verrou de fichiers et la limite de débit passent à 100 % (lignes et branches), sur de vrais dépôts git et un `gh` simulé.

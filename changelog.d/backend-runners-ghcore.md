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
- **Les workflows GitHub visent toujours le dépôt configuré** : les commentaires, labels et
  lectures d'issues, ainsi que les appels à l'API (fichiers et commits d'une PR, commentaires
  depuis la dernière revue, comparaison de commits, approbation des workflows de fork), ne
  dépendent plus du dépôt que le dossier local désigne. Une lecture de l'API avec des paramètres
  reste une lecture au lieu de partir en écriture, et l'assignation d'une PR à plusieurs personnes
  envoie bien la liste des comptes.
- **La revue de PR GitHub en plusieurs passes rapporte enfin ce que le modèle a trouvé** :
  quand l'orchestrateur parallèle est désactivé, chaque passe (balayage rapide, sécurité,
  qualité, structure, tri des commentaires d'autres outils d'IA, analyse approfondie) lisait la
  réponse du modèle sous une forme que le client ne produit plus, et la revue se terminait
  toujours sans aucun constat.
- **La revue de suivi d'une PR GitHub garde la réponse structurée du modèle** même quand le SDK
  ne la donne que dans son message de fin : elle ne retombait plus alors sur la lecture
  heuristique du diff.
- **Lots d'issues GitHub enregistrés pour de bon** : les lots créés par le regroupement, ceux
  validés dans l'assistant et ceux qui passent en analyse sont maintenant écrits sur le disque
  (ils restaient en mémoire), et l'état des lots s'affiche au lieu d'échouer dès qu'un lot existe.
- **Revue de PR GitHub** : les réponses aux commentaires des outils d'IA sont publiées quand la
  publication automatique est activée (elles échouaient toutes), le suivi d'une revue interroge
  le dépôt configuré, et une revue ou un suivi terminé ne laisse plus la PR « en cours de revue »
  pendant trente minutes. La ligne de synthèse ne dit plus « tous les checks passent » quand la
  CI tourne encore, et un constat dont le titre parle de CI ou de conflit de merge reste compté
  comme un problème de code.

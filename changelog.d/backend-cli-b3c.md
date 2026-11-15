---
section: 🧪 Filets de test
---

- **Couverture backend, lot B3c (CLI)** : tout le dossier `cli/` passe à 100 %. Les commandes de workspace tournent sur de vrais dépôts git, `python -m cli.main` est lancé comme le fait l'application, et `handle_build_command` est testé de bout en bout : build bloqué sans approbation, reprise d'un build existant, worktree isolé, QA, pause, découpage, arrêt et plantage.
- **Ctrl+C pendant un build** : reprendre le build après la pause plantait (variable inconnue), et le retour à l'état « en cours » visait un état qui n'existe pas. Les deux sont corrigés.
- **Auto-réparation, mode tableau de bord** : `--dashboard` plantait au lieu d'afficher le tableau ; il sort maintenant en erreur si le tableau ne peut pas s'ouvrir.
- **Budget des coûts** : la vue du budget affichait la dépense totale depuis toujours au lieu de celle de la période.
- **Streaming** : la relecture d'un enregistrement lisait une option que l'analyseur ne définit pas, et `--streaming-port` était ignoré.
- **Lots de tâches** : le statut et le nettoyage reposent sur l'approbation réelle de la QA, plus sur la seule présence d'un rapport (un rapport de rejet comptait comme approuvé) ; le nom du dossier d'une tâche suit le même format que celui du tableau Kanban.
- **Création de PR** : `--create-pr --pr-body-file` sur un fichier illisible plantait (`NameError`) ; sans build trouvé, la commande renvoie maintenant son erreur en JSON comme les autres cas.
- **Code mort retiré** : les ajouts à `sys.path` du dossier parent dans chaque module de `cli/`, `find_specs_dir`, `collect_user_input_interactive`, `cleanup_old_worktrees_command`, `worktree_summary_command`, le repli jamais atteint sur `foundation.debug`, et des branches sans effet dans `handle_build_command`. Plusieurs `except Exception` sont resserrés sur les erreurs réellement possibles.

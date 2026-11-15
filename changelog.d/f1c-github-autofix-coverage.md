---
section: 🐛 Corrections
---

- **Approuver des lots d'auto-fix lance le runner comme les autres commandes de l'auto-fix** : avec l'environnement du runner (fournisseur choisi, jeton GitHub), sans bloquer l'app pendant l'exécution ; le dossier `.workpilot/github` est créé s'il manque, et le fichier des lots approuvés est supprimé même quand le runner échoue.
- **L'aperçu des lots dit qu'aucun résultat n'est revenu** quand le runner ne renvoie rien, au lieu du message sur un résultat illisible.
- **Le lanceur des runners GitHub et GitLab lit des lignes entières** : une ligne de progression ou un message d'expiration de connexion coupé entre deux morceaux de sortie était lu en deux et manqué ; la dernière ligne sans retour à la ligne est lue aussi.
- **La vérification de `gh` ne passe plus par un shell** : `gh` est cherché sur la machine (y compris les dossiers d'installation hors `PATH`), puis `gh auth status` est lancé avec une liste d'arguments.

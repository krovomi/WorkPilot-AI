---
section: 🐛 Corrections
---

- **Jeton Claude sous Linux** : le backend ne lisait jamais le Secret Service (il l'appelait sans connexion DBus, ce qui échouait à chaque fois) et ne lisait pas `~/.claude/.credentials.json`, où Claude Code range son jeton sous Linux. Sans `CLAUDE_CODE_OAUTH_TOKEN`, la CLI disait donc « aucun jeton » à une personne connectée. Les deux sont lus, dans cet ordre ; un profil ne lit toujours que sa propre entrée.
- **Source du jeton affichée par la CLI** : avec un profil sans identifiants, elle nommait le trousseau par défaut alors que le build ne s'en sert pas ; elle suit maintenant l'ordre de lecture du jeton.
- **Couverture backend, lot B2d** : `core/auth.py` passe à 100 % (variables d'environnement, fichier d'un profil, trousseau macOS, fichiers Windows, Secret Service, ce qui est donné au SDK, Git Bash sous Windows). Retirés, faute d'appelant ou parce qu'ils ne pouvaient pas aboutir : le déchiffrement des jetons `enc:` (il échouait toujours ; un tel jeton reste refusé avec la marche à suivre), le lancement du login (`trigger_login`, `ensure_authenticated`) et un avertissement de jeton différent qui ne pouvait jamais se déclencher.
- **Nom d'entrée d'un profil sous Windows** : un dossier de profil écrit avec `~` ou avec des `/` donnait un autre nom d'entrée que celui de l'app (le backend ne remplaçait pas les `/` par des `\` comme `credential-utils.ts`).

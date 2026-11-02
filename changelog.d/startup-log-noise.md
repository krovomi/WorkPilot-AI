---
section: 🐛 Corrections
---

- **Le lancement de l'application ne remplit plus la console de messages inutiles.** Plus d'avertissements de build `INEFFECTIVE_DYNAMIC_IMPORT`, plus d'avertissements Electron sur les appels `safeStorage` synchrones dépréciés (le chiffrement des secrets passe par l'API asynchrone), plus d'avertissement Node `DEP0190` ni de `RuntimeWarning` Python au démarrage du serveur de streaming. Les outils CLI (Claude, Git, gh…) ne sont plus redétectés à chaque lecture des réglages, les vérifications de version Claude Code, Copilot et de mise à jour lancées en même temps n'en font plus qu'une, et la base analytics n'est plus initialisée deux fois. Les messages d'information (handlers enregistrés, environnement Python, détections…) ne s'affichent plus qu'avec `DEBUG=true` (`pnpm dev:debug`).

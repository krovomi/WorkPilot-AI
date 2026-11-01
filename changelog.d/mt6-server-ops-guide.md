---
section: 📚 Documentation
---

- **Mode serveur : un guide d'exploitation.** `docs/server-operations.md` dit comment déployer le
  serveur d'une équipe sans lire le code : secrets à générer, accès Git, premier administrateur,
  proxy TLS devant l'API et le flux en direct, chaque variable avec son défaut, sauvegarde et
  restauration (PostgreSQL, clones, clé maître), mise à jour et retour en arrière, quotas, audit,
  changement des clés, run bloqué, et ce qui n'existe pas encore. `deploy/` gagne un exemple de
  proxy Caddy prêt à copier, et les copies locales (`.env.server`, clé SSH) sont ignorées par git.

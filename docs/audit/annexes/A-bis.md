# Annexe A bis — Avis de sécurité des dépendances (24 octobre 2026)

`Dependency Audit` (`quality-security.yml`) rougit sans changement de code quand un avis sort.
Le 24 octobre : `dompurify` ≤ 3.4.16 (critique), `electron` < 44.9.1, `body-parser` < 2.4.0 (par
`@modelcontextprotocol/sdk`), `undici` < 7.30.1 (par `jsdom`, `@electron/get`). Correction :
planchers `pnpm.overrides` relevés (`pnpm-workspace.yaml`), `dompurify` ^3.4.17 et Electron 44.9.3
(`apps/frontend/package.json`), lockfile régénéré par `pnpm install`. Vérification :
`pnpm audit --audit-level high` sans avis haut ni critique.

---

[Cahier de nettoyage](../AUDIT-NETTOYAGE.md)

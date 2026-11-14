---
section: 🧹 Maintenance
---

- **Les versions sortent toutes seules, au plus une par jour.** Quand `develop` n'a reçu aucune
  fusion depuis 2 h et que la version précédente a au moins 24 h, le pilote de release
  (`release-autopilot.yml`) déduit majeure, mineure ou patch des PR fusionnées (`feat`, `fix`,
  `!`/`BREAKING CHANGE`, fragments, labels `semver:*`), fait écrire par Claude Code la
  documentation de la version (README EN/FR, docs, wiki), ouvre `release/vX.Y.Z` → `main`, la
  fusionne par commit de merge quand elle est verte, puis fusionne `main` dans `develop`.

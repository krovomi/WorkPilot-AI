---
section: 🛠️ Qualité
---

- **`pnpm dev` et `pnpm build` n'affichent plus les trois avertissements
  `INEFFECTIVE_DYNAMIC_IMPORT`**. `python-runner-env`, `ensure-python` et les handlers CI/CD
  étaient importés dynamiquement par la mesure carbone, la source d'incidents et la veille des PR
  fusionnées, alors que d'autres fichiers les importaient déjà normalement : l'import dynamique ne
  servait à rien. Ils sont importés normalement, et la build refuse désormais tout nouvel import
  dynamique de ce genre.

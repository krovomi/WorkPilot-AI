---
section: ✨ Nouveautés
---

- **Les chiffres d'usage du serveur d'équipe, calculés par le serveur.** Les routes
  `/admin/usage/*` (permission `usage.read`) donnent, sur une période et avec des filtres par
  personne, groupe, projet, provider et modèle : les chiffres clés (tokens, coût, part du budget,
  personnes actives, taux de succès), la consommation par jour et par provider, le détail par
  personne avec sa chronologie, les providers et modèles par phase, les projets, les pages
  ouvertes, l'entonnoir d'adoption, le coût par tâche livrée et le délai jusqu'au merge, les
  échecs groupés par cause, qui est connecté et les comptes dormants. Chaque table s'exporte en
  CSV (export audité) ; `/admin/platform/usage/*` donne les mêmes vues pour toute la plateforme.
  Registre RGPD mis à jour : [`docs/server-usage-data.md`](docs/server-usage-data.md).

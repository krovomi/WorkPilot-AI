---
section: 🐛 Corrections
---

- **Les champs de date suivent la langue de l'app** : les dates de sprint, de rapport d'usage, de délégation, de changelog, le mois de conformité et les heures d'automatisation s'écrivent 28/11/2026 et 14:30 en français, avec un calendrier qui commence le lundi ; l'anglais garde 11/28/2026 et 02:30 PM. Avant, ces champs natifs prenaient le format de la région du système (mm/dd/yyyy sous un Windows anglais).
- **Plus aucune date brute** : les mois (2026-11) et les jours (2026-11-28) encore affichés tels quels sur le bureau (conformité, carbone, Best-of-N, notebooks, déploiements, revues de PR, branches, usage, tests instables) et sur le mobile (mon usage, vue d'ensemble de l'administration) passent au format de la langue.

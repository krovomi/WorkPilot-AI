---
section: ✨ Nouveautés
---

- **Validation par niveaux des pull requests, en mode observation.** Chaque PR reçoit un niveau
  lu sans modèle : N0 (montée de version, documentation), N1 (correctif d'une seule couche, après
  la revue croisée), N2 (feature, plusieurs couches, migration, contrat d'API, montée majeure) ou
  N3 (secrets, auth, données personnelles, paiement, CI, fichiers de politique). N0 et N1 pourront
  fusionner seules quand la CI est verte ; N2 et N3 attendent une personne. Toutes les piles, tous
  les fournisseurs, toutes les forges. Ce premier lot livre le moteur et la section `approvals` de
  `workpilot.policy.yaml` (qui ne peut que durcir) ; rien ne fusionne encore seul.

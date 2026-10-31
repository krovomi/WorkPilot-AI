---
section: 🧹 Maintenance
---

- **Un seul mécanisme de variantes : Best-of-N.** `parallel_variations` (copie de spec sans
  agent, éteinte par défaut, et dont la boîte de dialogue n'était montée nulle part) est
  supprimé, avec sa route `/api/parallel-variations/*` et la variable
  `WORKPILOT_PARALLEL_VARIATIONS`. `replay` et `bench` restent séparés : l'un enregistre les
  sessions, l'autre rejoue des cartes pour noter les moteurs
  (`docs/architecture/variants-and-replays.md`).
- **Un fork de Time Travel ne prend plus de clé d'API.** Un fork est enregistré, jamais exécuté ;
  le champ ne servait à rien, et un ancien fichier de fork qui en porte une la perd à sa
  première lecture.

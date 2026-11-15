---
section: 🐛 Corrections
---

- **Refuser une tâche ne jette plus le travail en cours du projet principal** : quand la revue humaine renvoyait une tâche, l'app remettait à zéro tout le projet (`reset`, `checkout -- .`, `clean -fd`) dès qu'un worktree existait, et des modifications de la personne sans rapport avec la tâche partaient avec. Seule une fusion préparée par la tâche (« stage only ») est maintenant annulée, fichier par fichier.
- **Une tâche bloquée avant d'avoir écrit son plan peut être récupérée** : la récupération répondait « plan corrompu » ; elle repart d'un plan vide, vers le backlog ou vers la création de la spec si on la relance.
- **La création d'une PR depuis le statut ne laisse plus son script temporaire dans le projet** quand Python échoue, et un titre de tâche en HTML ne donne plus un titre de PR sur plusieurs lignes.
- **Un `$` dans le titre ou la description d'une tâche ne corrompt plus `spec.md`** (duplication et modification) : il était lu comme un motif de remplacement.
- **Reprendre la session d'une tâche refuse une session d'un autre provider** au lieu de la passer au SDK Claude.
- **Les arguments reçus du renderer sont revérifiés** pour le retour de revue, le modèle et l'effort d'une reprise, et le changement à chaud.

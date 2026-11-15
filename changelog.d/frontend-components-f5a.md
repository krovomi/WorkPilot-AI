---
section: 🧪 Filets de test
---

- **Composants du frontend, premier lot** : les badges Claude Code et Copilot, la page Worktrees, l'assistant de création de tâche, la fenêtre d'édition et la fenêtre du jeton Claude sont rendus et utilisés par leurs tests (installation, changement de version ou d'installation, fusion, PR, suppressions groupées, brouillon, conflit d'édition sur une carte du serveur). Le plancher de couverture Vitest passe de 29,5 % à 42,4 % des instructions.
- **Worktrees** : fusionner un worktree dont la tâche a disparu le dit dans la fenêtre de fusion, au lieu d'écrire l'erreur derrière elle sur la page.
- **Jeton Claude** : choisir un autre compte ne recharge plus la fenêtre (elle réaffichait son chargement et relisait tout à chaque clic) ; les boutons copier la commande et afficher le jeton ont un nom lisible par un lecteur d'écran.
- **Messages traduits** : les erreurs des badges Claude Code et Copilot, de la page Worktrees et de la fenêtre du jeton Claude s'affichent en français, et non plus en anglais en dur.

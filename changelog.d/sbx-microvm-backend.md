---
section: ✨ Nouveautés
---

- **Une microVM Docker par tâche, en option.** Dans Paramètres > Sandbox, « Lancer chaque tâche
  dans une microVM Docker » (coupé par défaut) fait tourner les commandes de la boucle WorkPilot
  (OpenAI, Google, Mistral, Copilot, modèles locaux…) dans une microVM Docker Sandboxes (`sbx`)
  propre à la carte : seuls le worktree, la spec et le dépôt git y sont montés (hooks et
  configuration git en lecture seule, `.workpilot/.env` masqué), le réseau est fermé hors des
  registres de paquets, et la mémoire et les processeurs sont bornés. Sous Windows 11, c'est le
  premier bac à sable des commandes. Sans `sbx` prêt, le bac à sable de l'OS prend le relais et
  la carte dit pourquoi. La télémétrie de `sbx` est coupée.

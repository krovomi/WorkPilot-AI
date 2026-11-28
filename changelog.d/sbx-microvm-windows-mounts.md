---
section: 🐛 Corrections
---

- **MicroVM Docker sous Windows.** Le worktree d'une tâche est monté comme sbx l'exige (sans
  cible, à `/c/…` dans la VM) : la microVM se crée sous Windows 11 et git y voit le dépôt. Une
  commande qui lit son entrée la reçoit, les autres ne bloquent plus sbx.

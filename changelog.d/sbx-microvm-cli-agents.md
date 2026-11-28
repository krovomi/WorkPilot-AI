---
section: ✨ Nouveautés
---

- **Un CLI d'agent dans la microVM de la tâche (expérimental).** Avec la microVM allumée, un second
  interrupteur de Paramètres > Sandbox lance OpenCode dans la VM de la tâche, avec les clés que vous
  avez rangées dans sbx (`sbx secret set openai`…). WorkPilot ne copie aucune clé : dans la VM, le
  CLI ne voit qu'un substitut, et le proxy de sbx ajoute la vraie clé. Sans clé rangée, le CLI
  reste sur l'hôte et la carte dit pourquoi. Coupé par défaut.
